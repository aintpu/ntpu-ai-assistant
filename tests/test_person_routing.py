import os
import unittest
from unittest.mock import patch

os.environ.setdefault("NTPU_SKIP_INDEX_BUILD", "1")
import agentic_v2_5_4high as core  # noqa: E402


class PersonRoutingTests(unittest.TestCase):
    def setUp(self):
        core._mcp_person_units.cache_clear() if hasattr(core._mcp_person_units, "cache_clear") else None

    def _local(self, rows):
        return patch.object(core, "_grounding_contents", return_value=rows)

    def test_passing_local_mention_yields_to_official_page(self):
        # 體育室總檔順帶提到林昭吟（權重 1），社科院官網〈院長簡介〉寫明身分：以社科院為準
        with self._local([("…委員：林昭吟、…", "ope", 1)]), \
                patch.object(core, "official_name_in", return_value=[]), \
                patch.object(core, "_mcp_person_units", return_value="coss"):
            self.assertEqual(core.known_person_office("林昭吟是誰"), ("coss", "林昭吟"))

    def test_local_identity_document_still_wins(self):
        with self._local([("研發長 林某某", "ord", 1000)]), \
                patch.object(core, "official_name_in", return_value=[]), \
                patch.object(core, "_mcp_person_units", return_value="coss") as mcp:
            self.assertEqual(core.known_person_office("林某某是誰"), ("ord", "林某某"))
            mcp.assert_not_called()

    def test_passing_mention_kept_when_official_sites_have_nothing(self):
        with self._local([("…林某某…", "ope", 1)]), \
                patch.object(core, "official_name_in", return_value=[]), \
                patch.object(core, "_mcp_person_units", return_value=None):
            self.assertEqual(core.known_person_office("林某某是誰"), ("ope", "林某某"))

    def test_person_names_are_searched_on_their_own(self):
        self.assertEqual(core.asked_person_names("林昭吟是誰"), ["林昭吟"])
        self.assertEqual(core.asked_person_names("郭文忠老師的研究領域"), ["郭文忠"])
        self.assertEqual(core.asked_person_names("經濟系有哪些專任老師？"), [])

    def test_faculty_questions_search_faculty_page_titles(self):
        self.assertIn("專任教師", core.FACULTY_PAGE_TERMS)
        self.assertIn("兼任教師", core.FACULTY_PAGE_TERMS)


if __name__ == "__main__":
    unittest.main()
