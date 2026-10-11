import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    import agentic_v2_5_4high as core
    from langchain_core.documents import Document
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    core = None
    _IMPORT_ERROR = str(exc)


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class IndexVersionTests(unittest.TestCase):
    """老師建議 四-1：FAISS、BM25 與比對快取一起更新，並記錄版本。"""

    def test_refresh_swaps_faiss_bm25_and_clears_caches_together(self):
        docs = [Document(page_content="宿舍申請說明", metadata={"title": "宿舍", "dept": "osa"}),
                Document(page_content="選課時間", metadata={"title": "選課", "dept": "oaa"})]

        def fake_build(self):
            self.docs_zh, self.fingerprint, self.built_at = docs, "abcdef1234567890", "2026-10-11T00:00:00Z"

        old = (core.INDEX, core.BM25_ZH, core.BM25_ZH_CORPUS)
        core._title_index, core._content_index = ["stale"], ["stale"]
        try:
            with patch.object(core.OPEIndex, "build", fake_build), patch.object(core.OPEIndex, "__init__", lambda self: None):
                version = core.refresh_knowledge_index()
            self.assertEqual(version, {"fingerprint": "abcdef123456", "built_at": "2026-10-11T00:00:00Z",
                                       "faiss_docs": 2, "bm25_docs": 2, "aligned": True})
            self.assertIs(core.INDEX.docs_zh, docs)
            self.assertIsNone(core._title_index)
            self.assertIsNone(core._content_index)
        finally:
            core.INDEX, core.BM25_ZH, core.BM25_ZH_CORPUS = old


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class SourceTimeTests(unittest.TestCase):
    """老師建議 四-2：來源修訂、系統抓取、最後確認分開，不把最近抓取說成內容已確認。"""

    def setUp(self):
        core._reset_source_collector()

    def test_cards_carry_separate_times(self):
        page = Document(page_content="學雜費繳費期限", metadata={
            "title": "學雜費專區", "url": "https://u/fee", "type": "page", "date": "2026-07-08",
            "fetched_at": "2026-10-11", "source_id": "mcp:page:oaa:1"})
        official = core._official_document({
            "id": "x" * 24, "unit": "oaa", "title": "教務長", "name": "陳婉琪", "nameEn": "Wan-Chi Chen",
            "pageUpdatedAt": "2026-07-08T06:07:40.753Z", "sourceUrl": "https://new.ntpu.edu.tw/oaa/director",
            "provenance": {"verifiedAt": "2026-10-11T02:00:00Z"}})
        core._collect_source_docs([page, official])
        core._finalize_sources("學雜費見 https://u/fee ；教務長是陳婉琪，見 https://new.ntpu.edu.tw/oaa/director")
        cards = {c["url"]: c for c in core.get_last_sources()}
        self.assertEqual(cards["https://u/fee"]["revised_at"], "2026-07-08")
        self.assertEqual(cards["https://u/fee"]["fetched_at"], "2026-10-11")
        self.assertNotIn("confirmed_at", cards["https://u/fee"])  # 一般頁面只是抓取，不算確認
        self.assertEqual(cards["https://new.ntpu.edu.tw/oaa/director"]["confirmed_at"], "2026-10-11")


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class QueryTraceTests(unittest.TestCase):
    """老師建議 五-1：日誌保存檢索片段與各來源的時間。"""

    def test_trace_snippets_keep_source_and_times(self):
        core._reset_source_collector()
        core._collect_source_docs([Document(page_content="學雜費" * 200, metadata={
            "title": "學雜費專區", "url": "https://u/fee", "type": "page", "date": "2026-07-08",
            "fetched_at": "2026-10-11", "source_id": "mcp:page:oaa:1"})])
        [snip] = core.retrieval_snippets_for_trace()
        self.assertEqual(snip["source_id"], "mcp:page:oaa:1")
        self.assertEqual((snip["revised_at"], snip["fetched_at"]), ("2026-07-08", "2026-10-11"))
        self.assertEqual(len(snip["snippet"]), core.TRACE_SNIPPET_CHARS)
        self.assertNotIn("confirmed_at", snip)


if __name__ == "__main__":
    unittest.main()
