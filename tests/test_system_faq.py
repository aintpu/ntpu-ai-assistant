import json
import unittest
from pathlib import Path

from system_faq import (
    QueryDomain,
    SystemFAQRetriever,
    detect_language,
    should_route_system,
    should_use_system_fallback,
)


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "system_content.json"


class SystemFAQTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.retriever = SystemFAQRetriever(CONTENT)

    def test_domain_contract_contains_system_and_seven_offices(self):
        self.assertEqual(
            {domain.value for domain in QueryDomain},
            {"SYSTEM", "OPE", "GE", "LC", "OAA", "OSA", "HR", "OGA", "OTHER"},
        )

    def test_content_has_at_least_15_bilingual_entries(self):
        content = json.loads(CONTENT.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(content["faqs"]), 15)
        for faq in content["faqs"]:
            for key in ("question_zh", "question_en", "answer_zh", "answer_en"):
                self.assertTrue(faq[key], f"{faq['id']} missing {key}")
            self.assertEqual(faq["source"]["type"], "system")
            self.assertTrue(faq["source"]["url"].startswith("https://aia.ntpu.ai/about#"))

    def test_primary_system_questions_route_to_expected_faq(self):
        cases = {
            "你可以回答哪些問題？": "system-capabilities",
            "這個系統怎麼使用？": "system-how-to-use",
            "需要登入嗎？": "system-login",
            "你的資料來源是哪裡？": "system-sources",
            "可以繼續追問嗎？": "system-followups",
            "這個系統與 ChatGPT 有什麼不同？": "system-vs-chatgpt",
            "How often is the data updated?": "system-updates",
            "Can I ask questions in English?": "system-language",
        }
        for query, faq_id in cases.items():
            with self.subTest(query=query):
                match = self.retriever.best(query)
                self.assertEqual(match.faq_id, faq_id)
                self.assertTrue(should_route_system(query, match, threshold=0.56))

    def test_aliases_are_retrievable(self):
        cases = {
            "這網站怎麼玩": "system-how-to-use",
            "會記得上一題嗎": "system-followups",
            "跟ChatGPT差在哪": "system-vs-chatgpt",
            "Is login required?": "system-login",
        }
        for query, faq_id in cases.items():
            with self.subTest(query=query):
                match = self.retriever.best(query)
                self.assertEqual(match.faq_id, faq_id)
                self.assertTrue(match.exact)

    def test_department_content_regressions_do_not_route_system(self):
        questions = [
            "語言中心英文免修 TOEIC 要幾分？",
            "向度通識畢業要幾學分？",
            "我要辦理休學需要什麼？",
            "宿舍如何申請？",
            "教職員請病假可以請幾天？",
            "總務處設備報修要怎麼申請？",
            "綜合體育館怎麼借？",
            "Can you tell me how to apply for a dorm?",
            "Can I ask how many General Education credits I need?",
            "What TOEIC score is required for the English exemption?",
        ]
        for query in questions:
            with self.subTest(query=query):
                match = self.retriever.best(query)
                self.assertFalse(should_route_system(query, match, threshold=0.56))

    def test_mixed_capability_question_routes_system(self):
        query = "你有語言中心英文免修的資料嗎？"
        match = self.retriever.best(query)
        self.assertTrue(should_route_system(query, match, threshold=0.56))

    def test_fallback_is_stricter_and_weather_remains_unsupported(self):
        system_query = "這網站怎麼玩"
        system_match = self.retriever.best(system_query)
        self.assertTrue(should_use_system_fallback(system_query, system_match, threshold=0.72))

        other_query = "明天台北會下雨嗎？"
        other_match = self.retriever.best(other_query)
        self.assertFalse(should_use_system_fallback(other_query, other_match, threshold=0.72))

    def test_system_source_schema_and_language(self):
        zh_match = self.retriever.best("你可以回答哪些問題？")
        source = zh_match.source("zh-TW")
        self.assertEqual(source["type"], "system")
        self.assertEqual(source["faq_id"], "system-capabilities")
        self.assertIn("系統說明", source["title"])
        self.assertEqual(detect_language("What can you do?"), "en")
        self.assertEqual(detect_language("你會什麼？"), "zh-TW")


if __name__ == "__main__":
    unittest.main()
