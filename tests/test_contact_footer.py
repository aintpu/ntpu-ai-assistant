import os
import unittest

os.environ.setdefault("NTPU_SKIP_INDEX_BUILD", "1")
import agentic_v2_5_4high as core  # noqa: E402


class ContactFooterTests(unittest.TestCase):
    def test_every_unit_has_an_official_contact_entry(self):
        for dept in core.DEPT_NAMES:
            info = core.UNIT_CONTACTS.get(dept)
            self.assertIsNotNone(info, dept)
            self.assertTrue(info["source"].startswith("https://"), dept)

    def test_footer_lists_unit_phone_and_staff_page(self):
        footer = core.contact_footer("oaa")
        self.assertIn("**承辦單位**：教務處", footer)
        self.assertIn("#66102", footer)
        self.assertIn("(https://new.ntpu.edu.tw/oaa/organizations)", footer)

    def test_no_phone_is_invented_when_the_site_lists_none(self):
        footer = core.contact_footer("oga")
        self.assertNotIn("電話", footer)
        self.assertIn("(https://new.ntpu.edu.tw/oga/members)", footer)

    def test_cross_unit_answers_get_no_footer(self):
        self.assertEqual(core.contact_footer(None), "")
        self.assertEqual(core.contact_footer("OTHER"), "")

    def test_english_labels(self):
        self.assertIn("**Responsible unit**：Library", core.contact_footer("lib", "en"))


if __name__ == "__main__":
    unittest.main()
