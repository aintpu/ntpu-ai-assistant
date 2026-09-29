import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class SecurityHardeningContractTests(unittest.TestCase):
    def test_faiss_cache_does_not_enable_pickle_deserialization(self):
        source = (ROOT / "agentic_v2_5_4high.py").read_text(encoding="utf-8")
        self.assertNotIn("allow_dangerous_deserialization=True", source)
        self.assertNotIn("pickle.load(", source)
        self.assertNotIn("pickle.dump(", source)
        self.assertIn("docs_sha256", source)
        self.assertIn("index_sha256", source)
        self.assertNotIn("deep_translator", source)

    def test_worker_handles_static_assets_before_adding_security_headers(self):
        config = (ROOT / "cf/wrangler.jsonc").read_text(encoding="utf-8")
        security = (ROOT / "cf/src/security.js").read_text(encoding="utf-8")
        self.assertIn('"run_worker_first": true', config)
        self.assertIn("Content-Security-Policy", security)
        self.assertIn("frame-ancestors 'none'", security)
        self.assertIn("Strict-Transport-Security", security)
        self.assertIn("X-Content-Type-Options", security)

    def test_regulation_downloads_are_allowlisted_and_bounded(self):
        source = (ROOT / "scripts/sync_regulation_documents.py").read_text(encoding="utf-8")
        self.assertIn("ALLOWED_DOWNLOAD_HOST_SUFFIXES", source)
        self.assertIn("MAX_DOWNLOAD_BYTES", source)
        self.assertIn("_ValidatedRedirectHandler", source)
        self.assertIn("from defusedxml import ElementTree", source)


if __name__ == "__main__":
    unittest.main()
