import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "evaluate", "benchmark"))
import build_seed  # noqa: E402


class BenchmarkSeedTests(unittest.TestCase):
    def _parse(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
            fh.write(text)
        try:
            return build_seed.parse_faq_markdown(fh.name)
        finally:
            os.unlink(fh.name)

    def test_answer_may_start_with_a_field_like_line(self):
        # EEC-MGT-005 的回答第一行是「適用對象：…」，不能被當成欄位而把整題丟掉
        [(q, a, f)] = self._parse("### 臺北校區場地怎麼申請借用？\n\n適用對象：校內外單位\n\n線上預約\n\n"
                                  "FAQ 編號：EEC-MGT-005\n\n來源網址：https://x\n\n來源日期：2026-01-01\n")
        self.assertIn("適用對象：校內外單位", a)
        self.assertEqual((f["FAQ 編號"], f["來源網址"], f["來源日期"]), ("EEC-MGT-005", "https://x", "2026-01-01"))

    def test_risk_and_type_rules(self):
        self.assertEqual(build_seed.risk_of("學分抵免怎麼申請？", ""), "high")
        self.assertEqual(build_seed.risk_of("研發處的電話是多少？", ""), "low")
        self.assertEqual(build_seed.risk_of("首頁有哪些常用連結？", "補助金額與期限"), "medium")
        self.assertEqual(build_seed.type_of("獎學金怎麼申請？"), "procedure")
        self.assertEqual(build_seed.type_of("圖書館在哪裡？"), "faq")

    def test_built_benchmark_has_every_required_field_and_unique_ids(self):
        path = os.path.join(ROOT, "evaluate", "benchmark", "benchmark.jsonl")
        items = [json.loads(line) for line in open(path, encoding="utf-8")]
        self.assertGreaterEqual(len(items), 1000)
        self.assertEqual(len({i["id"] for i in items}), len(items))
        for i in items:
            for key in ("standard_answer", "official_source", "source_date", "risk_level", "answerable"):
                self.assertIn(key, i)
            self.assertIn(i["type"], build_seed.TYPE_TARGETS)
            self.assertIn(i["risk_level"], ("high", "medium", "low"))
            if i["answerable"]:
                self.assertTrue(i["standard_answer"].strip(), i["id"])


if __name__ == "__main__":
    unittest.main()
