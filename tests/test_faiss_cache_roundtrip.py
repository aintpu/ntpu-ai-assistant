"""Runtime round-trip tests for the pickle-free FAISS cache.

Uses deterministic fake embeddings so the test never calls a paid embeddings
API. Verifies that the cache writes docs.json / index.faiss / manifest.json,
reloads correctly, and refuses to load (falls back to rebuild) when any cache
file is tampered with.
"""
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch


os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    import agentic_v2_5_4high as core
    from langchain_community.vectorstores import FAISS
    from langchain_core.documents import Document
    from langchain_core.embeddings import DeterministicFakeEmbedding
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    core = None
    _IMPORT_ERROR = str(exc)


FINGERPRINT = "test-fingerprint"


def _sample_docs():
    return [
        Document(
            page_content="體育室場地借用辦法：須於三日前提出申請。",
            metadata={"page": "法規", "type": "regulation", "title": "場地借用", "url": "https://pe.ntpu.edu.tw/a"},
        ),
        Document(
            page_content="Language Center: English proficiency graduation requirement.",
            metadata={"page": "FAQ", "type": "faq", "title": "English requirement", "url": "https://lc.ntpu.edu.tw/b"},
        ),
        Document(
            page_content="人事室差勤請假規定與表單下載。",
            metadata={"page": "人事室", "type": "page", "title": "差勤", "date": "2026-09-01"},
        ),
    ]


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class FaissCacheRoundTripTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cache_dir = pathlib.Path(self._tmp.name) / ".faiss_cache"
        self._patch = patch.object(core, "INDEX_CACHE_DIR", str(self.cache_dir))
        self._patch.start()
        self.embeddings = DeterministicFakeEmbedding(size=16)

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _new_index(self):
        index = core.OPEIndex.__new__(core.OPEIndex)
        index.docs_zh = []
        index.docs_en = []
        index.faiss_zh = None
        index.faiss_en = None
        index.embeddings = self.embeddings
        return index

    def _write_cache(self):
        index = self._new_index()
        index.docs_zh = _sample_docs()
        index.faiss_zh = FAISS.from_documents(index.docs_zh, self.embeddings)
        with patch("builtins.print"):
            index._save_cache(FINGERPRINT)
        return index

    def _load(self, fingerprint=FINGERPRINT):
        index = self._new_index()
        with patch("builtins.print"):
            loaded = index._try_load_cache(fingerprint)
        return loaded, index

    def test_save_writes_only_json_and_native_faiss_files(self):
        self._write_cache()
        names = sorted(p.name for p in self.cache_dir.iterdir())
        self.assertEqual(names, ["docs.json", "index.faiss", "manifest.json"])
        manifest = json.loads((self.cache_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], core.INDEX_CACHE_VERSION)
        self.assertEqual(manifest["fingerprint"], FINGERPRINT)
        self.assertEqual(manifest["document_count"], 3)
        self.assertEqual(manifest["docs_sha256"], core._sha256_file(str(self.cache_dir / "docs.json")))
        self.assertEqual(manifest["index_sha256"], core._sha256_file(str(self.cache_dir / "index.faiss")))

    def test_valid_cache_round_trips_documents_and_search(self):
        original = self._write_cache()
        loaded, index = self._load()
        self.assertTrue(loaded)
        self.assertEqual(
            [(d.page_content, d.metadata) for d in index.docs_zh],
            [(d.page_content, d.metadata) for d in original.docs_zh],
        )
        query = original.docs_zh[1].page_content
        expected = original.faiss_zh.similarity_search(query, k=2)
        actual = index.faiss_zh.similarity_search(query, k=2)
        self.assertEqual([d.page_content for d in actual], [d.page_content for d in expected])
        self.assertEqual(actual[0].page_content, query)

    def test_fingerprint_mismatch_is_cache_miss(self):
        self._write_cache()
        loaded, index = self._load("different-fingerprint")
        self.assertFalse(loaded)
        self.assertEqual(index.docs_zh, [])

    def test_tampered_docs_json_is_rejected(self):
        self._write_cache()
        docs_path = self.cache_dir / "docs.json"
        payload = json.loads(docs_path.read_text(encoding="utf-8"))
        payload[0]["page_content"] = "被竄改的內容"
        docs_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        loaded, index = self._load()
        self.assertFalse(loaded)
        self.assertIsNone(index.faiss_zh)

    def test_tampered_index_faiss_is_rejected(self):
        self._write_cache()
        index_path = self.cache_dir / "index.faiss"
        data = bytearray(index_path.read_bytes())
        data[-1] ^= 0xFF
        index_path.write_bytes(bytes(data))
        loaded, index = self._load()
        self.assertFalse(loaded)
        self.assertIsNone(index.faiss_zh)

    def test_tampered_manifest_version_is_rejected(self):
        self._write_cache()
        manifest_path = self.cache_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = core.INDEX_CACHE_VERSION + 1
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        loaded, _ = self._load()
        self.assertFalse(loaded)

    def test_document_count_mismatch_is_rejected_even_with_consistent_hashes(self):
        self._write_cache()
        docs_path = self.cache_dir / "docs.json"
        payload = json.loads(docs_path.read_text(encoding="utf-8"))
        docs_path.write_text(json.dumps(payload[:-1], ensure_ascii=False), encoding="utf-8")
        manifest_path = self.cache_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["docs_sha256"] = core._sha256_file(str(docs_path))
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        loaded, index = self._load()
        self.assertFalse(loaded)
        self.assertIsNone(index.faiss_zh)

    def test_legacy_pickle_cache_is_ignored(self):
        self.cache_dir.mkdir(parents=True)
        (self.cache_dir / "fingerprint.txt").write_text(FINGERPRINT, encoding="utf-8")
        (self.cache_dir / "docs.pkl").write_bytes(b"not-a-pickle-and-must-never-be-loaded")
        (self.cache_dir / "faiss").mkdir()
        (self.cache_dir / "faiss" / "index.pkl").write_bytes(b"legacy")
        with patch("pickle.load", side_effect=AssertionError("pickle.load must not be called")), \
             patch("pickle.loads", side_effect=AssertionError("pickle.loads must not be called")):
            loaded, _ = self._load()
        self.assertFalse(loaded)

    def test_build_rebuilds_after_tamper_and_rewrites_valid_cache(self):
        self._write_cache()
        (self.cache_dir / "docs.json").write_text("[]", encoding="utf-8")
        index = self._new_index()
        with patch.object(core, "_data_fingerprint", return_value=FINGERPRINT), \
             patch("builtins.print"):
            index.build()
        self.assertIsNotNone(index.faiss_zh)
        self.assertGreater(len(index.docs_zh), 0)
        loaded, reloaded = self._load()
        self.assertTrue(loaded)
        self.assertEqual(len(reloaded.docs_zh), len(index.docs_zh))


if __name__ == "__main__":
    unittest.main()
