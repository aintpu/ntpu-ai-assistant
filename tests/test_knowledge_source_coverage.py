import unittest
from pathlib import Path

from knowledge_source_audit import OFFICE_SPECS, audit_all


class KnowledgeSourceCoverageTests(unittest.TestCase):
    def test_every_supported_office_inventory_item_has_readable_body(self):
        results = audit_all()
        self.assertEqual({result.office for result in results}, set(OFFICE_SPECS))
        failures = {
            result.office: {
                "missing": result.missing_titles,
                "unreadable": result.unreadable_titles,
            }
            for result in results
            if not result.passed
        }
        self.assertFalse(failures, failures)

    def test_every_supported_office_has_inventory_rows(self):
        for result in audit_all():
            with self.subTest(office=result.office):
                self.assertGreater(result.inventory_rows, 0)
                self.assertEqual(result.readable_rows, result.inventory_rows)

    def test_backend_registers_all_supplemental_regulation_corpora(self):
        backend = (Path(__file__).resolve().parents[1] / "agentic_v2_5_4high.py").read_text(
            encoding="utf-8"
        )
        for filename in (
            "ge_regulations_extra.md",
            "oaa_regulations.md",
            "osa_regulations.md",
            "hr_regulations.md",
            "oga_regulations.md",
        ):
            with self.subTest(filename=filename):
                self.assertIn(filename, backend)
        self.assertIn('"hr": "人事室"', backend)
        self.assertIn('"oga": "總務處"', backend)

    def test_hr_annual_leave_answer_and_primary_rule_are_searchable(self):
        root = Path(__file__).resolve().parents[1]
        faq = (root / "crawler_data" / "hr_content.md").read_text(encoding="utf-8")
        rules = (root / "crawler_data" / "hr_regulations.md").read_text(encoding="utf-8")
        self.assertIn("### 行政人員一年有多少天特休假期？", faq)
        for expected in ("3 日", "7 日", "10 日", "14 日", "15 日", "最高 30 日"):
            self.assertIn(expected, faq)
        self.assertIn("第二十三條 〈特別休假〉", rules)
        self.assertIn("服務滿六個月以上一年未滿者，三日", rules)


if __name__ == "__main__":
    unittest.main()
