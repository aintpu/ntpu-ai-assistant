import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    import agentic_v2_5_4high as core
    import mcp_client
    from conversation_guardrail import ConversationResolution
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    core = None
    _IMPORT_ERROR = str(exc)


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class KeepIntentTests(unittest.TestCase):
    """老師建議 三-1：保留當前提問的人名與意圖。"""

    def test_asked_person_names_but_not_titles(self):
        self.assertEqual(core.asked_person("誰是宋明謙？"), "宋明謙")
        self.assertEqual(core.asked_person("who is 宋明翰"), "宋明翰")
        self.assertEqual(core.asked_person("who is Thijs Velema"), "Thijs Velema")
        for q in ("現任校長是誰", "Who is the president of NTPU?", "教務長是誰", "誰是校長"):
            self.assertIsNone(core.asked_person(q), q)

    def test_rewrite_that_drops_the_name_is_reverted(self):
        # 上一輪問校長，這一輪問宋明謙：改寫成問校長就改回原始問題，也不反問
        res = ConversationResolution(is_followup=True, standalone_query="國立臺北大學的校長是誰？",
                                     topic="校長資訊", ambiguity=True, ambiguity_reason="資訊不足")
        fixed, changed = core.keep_asked_person("誰是宋明謙？", res)
        self.assertTrue(changed)
        self.assertEqual(fixed.standalone_query, "誰是宋明謙？")
        self.assertFalse(fixed.ambiguity)
        ok = ConversationResolution(standalone_query="誰是陳宥杉")
        self.assertEqual(core.keep_asked_person("誰是陳宥杉", ok), (ok, False))

    def test_blocked_unknown_person_says_so(self):
        self.assertIn("查不到「宋明謙」", core._blocked_message("誰是宋明謙？"))
        self.assertIn('named "宋明翰"', core._blocked_message("who is 宋明翰"))
        self.assertEqual(core._blocked_message("幫我寫一首詩"), core._BLOCKED_MSG)


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class CorrectionTests(unittest.TestCase):
    """老師建議 三-2：主動更正先前錯答。"""

    HISTORY = [{"role": "user", "content": "the president of NTPU?"},
               {"role": "assistant", "content": "國立臺北大學的校長目前是宋明翰。"}]

    def test_no_history_no_instruction(self):
        self.assertEqual(core.correction_instruction([]), "")

    def test_roster_conflict_requires_explicit_correction(self):
        roster = [{"title": "校長", "name": "林道通", "nameEn": "Dalton Daw-Tung Lin", "titleEnSearch": ["president"]}]
        with patch.object(core, "current_officials_for", return_value=roster):
            fixes = core.roster_corrections(self.HISTORY, "國立臺北大學的校長目前是？")
            self.assertEqual(fixes, [("校長", "林道通")])
            right = [{"role": "assistant", "content": "現任校長是林道通。"}]
            self.assertEqual(core.roster_corrections(right, "校長是誰"), [])
        text = core.correction_instruction(self.HISTORY, fixes)
        self.assertIn("宋明翰", text)
        self.assertIn("現任校長是林道通", text)
        # 模型漏寫更正時由程式補上；已寫了就不重複
        self.assertTrue(core.ensure_correction("現任校長是林道通。", fixes, "zh").startswith("更正：上一則回答關於校長的說法有誤"))
        self.assertEqual(core.ensure_correction("更正：上一則回答有誤。現任校長是林道通。", fixes, "zh"),
                         "更正：上一則回答有誤。現任校長是林道通。")
        self.assertEqual(core.ensure_correction("現任校長是林道通。", [], "zh"), "現任校長是林道通。")


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class OfficialNameFixTests(unittest.TestCase):
    def test_romanization_next_to_chinese_name_becomes_official(self):
        roster = [{"name": "林道通", "nameEn": "Dalton Daw-Tung Lin"}]
        with patch.object(core, "current_officials_roster", return_value=roster):
            fix = core.fix_official_english_names
            self.assertEqual(fix("The president is **Dr. Lin Dao-Tung (林道通)**."),
                             "The president is **Dalton Daw-Tung Lin (林道通)**.")
            self.assertEqual(fix("He is 林道通 (Lin Tao-Tung)."), "He is 林道通 (Dalton Daw-Tung Lin).")
            self.assertEqual(fix("Dalton Daw-Tung Lin (林道通)"), "Dalton Daw-Tung Lin (林道通)")
            self.assertEqual(fix("No Chinese name here, Lin Dao-Tung."), "No Chinese name here, Lin Dao-Tung.")


if __name__ == "__main__":
    unittest.main()
