import re
import unittest
from collections import Counter
from pathlib import Path

from conversation_guardrail import run_scope_guardrail


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "crawler_data" / "oga_content.md"


class GeneralAffairsContentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text = CONTENT.read_text(encoding="utf-8")
        cls.entries = re.split(r"(?m)^### ", text)[1:]

    def test_contains_all_sixty_faqs(self):
        self.assertEqual(len(self.entries), 60)

    def test_each_faq_has_traceable_metadata_and_source(self):
        ids = []
        groups = []
        for entry in self.entries:
            faq_id = re.search(r"(?m)^FAQ 編號：(.+)$", entry)
            group = re.search(r"(?m)^承辦組別：(.+)$", entry)
            source = re.search(r"(?m)^資料來源：(.+)$", entry)
            url = re.search(r"(?m)^來源網址：(https?://\S+)$", entry)
            self.assertIsNotNone(faq_id)
            self.assertIsNotNone(group)
            self.assertIsNotNone(source)
            self.assertIsNotNone(url)
            ids.append(faq_id.group(1).strip())
            groups.append(group.group(1).strip())

        self.assertEqual(len(set(ids)), 60)
        self.assertEqual(
            Counter(groups),
            Counter({
                "營繕組": 10,
                "事務組": 10,
                "經管組": 10,
                "出納組": 10,
                "環境組": 10,
                "文書組": 10,
            }),
        )

    def test_every_faq_question_has_oga_fallback_route(self):
        def failing_complete(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        for entry in self.entries:
            question = entry.splitlines()[0].strip()
            with self.subTest(question=question):
                scope = run_scope_guardrail(
                    question,
                    {},
                    failing_complete,
                    retries=0,
                )
                self.assertEqual(scope.status, "IN_SCOPE")
                self.assertEqual(scope.office_hint, "oga")


if __name__ == "__main__":
    unittest.main()
