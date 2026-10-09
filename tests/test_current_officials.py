import os
import unittest
from unittest.mock import patch

# 與其他後端測試相同：不建 FAISS 索引、不連網路。
os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    import agentic_v2_5_4high as core
    import mcp_client
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    core = None
    mcp_client = None
    _IMPORT_ERROR = str(exc)


def _official(unit, title, name, name_en=None, official_en=None, term=None, title_en=()):
    return {
        "id": f"{unit[:4]}00000000000000000000"[:24].ljust(24, "0"),
        "unit": unit, "title": title, "name": name, "nameEn": name_en, "nameEnOfficial": official_en or name_en,
        "titleEnSearch": list(title_en), "term": term, "termSource": "校長介紹頁" if term else None, "note": None,
        "path": f"/{unit}", "pageTitle": title, "pageUpdatedAt": "2026-09-04T00:40:32.114Z",
        "sourceUrl": f"https://new.ntpu.edu.tw/{unit}",
        "provenance": {"verifiedAt": "2026-10-09T12:40:55.385Z", "sourceUrl": f"https://new.ntpu.edu.tw/{unit}"},
    }


ROSTER = [
    _official("president", "校長", "林道通", "Dalton Daw-Tung Lin", "DR. DALTON DAW-TUNG, LIN", "2025至今", ["president"]),
    _official("vice-president-academic", "學術副校長", "陳宥杉", "Yu-Shan Chen", title_en=["vice president for academic affairs"]),
    _official("oaa", "教務長", "陳婉琪", "Wan-Chi Chen", title_en=["dean of academic affairs"]),
    _official("edusp", "高教深耕計畫辦公室主任", "陳婉琪"),
    _official("oia", "國際長", None, "Thijs A. Velema", title_en=["dean of international affairs"]),
]


@unittest.skipIf(core is None, f"後端相依套件未安裝：{_IMPORT_ERROR}")
class CurrentOfficialsTests(unittest.TestCase):
    """老師建議 二-1：現任職務問題優先查 MCP 的現任主管資料。"""

    def setUp(self):
        core._officials_cache.update(at=0.0, items=[])
        self.env = patch.dict(os.environ, {"MCP_REGULATIONS": "1"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        core._officials_cache.update(at=0.0, items=[])

    def _call(self, items_for_keyword=None):
        def call(name, args):
            self.assertEqual(name, "get_current_officials")
            if "keyword" not in args:
                return {"items": ROSTER}
            return {"items": (items_for_keyword or {}).get(args["keyword"], []), "freshness": []}
        return patch.object(mcp_client, "call_tool", side_effect=call)

    def test_position_questions_are_recognised(self):
        with self._call():
            for q in ("現任校長是誰", "the president of NTPU?", "國立臺北大學的校長目前是？", "教務長？",
                      "Who is the dean of academic affairs?", "林道通的研究領域"):
                self.assertTrue(core.is_position_question(q), q)
            for q in ("校長室電話", "選課時間", "NTU library hours"):
                self.assertFalse(core.is_position_question(q), q)

    def test_official_document_states_fields_and_leaves_missing_ones_empty(self):
        doc = core._official_document(ROSTER[0])
        self.assertIn("中文姓名：林道通", doc.page_content)
        self.assertIn("DR. DALTON DAW-TUNG, LIN", doc.page_content)
        self.assertIn("任期：2025至今", doc.page_content)
        self.assertIn("以英文回答時，姓名一律寫作：Dalton Daw-Tung Lin", doc.page_content)
        self.assertIn("最後確認時間", doc.page_content)
        self.assertEqual(doc.metadata["url"], "https://new.ntpu.edu.tw/president")
        self.assertEqual(doc.metadata["dept"], "pres")
        no_en = core._official_document(ROSTER[3]).page_content
        self.assertIn("官網未提供（不得自行以拼音補上）", no_en)
        self.assertIn("任期：官網未寫明", no_en)
        self.assertIn("官網未載明中文姓名", core._official_document(ROSTER[4]).page_content)

    def test_search_database_puts_the_roster_first(self):
        with self._call({"教務長是誰": [ROSTER[2]]}), \
                patch.object(core, "retrieve_and_rerank", return_value=[]), \
                patch.object(core, "_record_evidence"):
            out = core.tool_search_database("教務長是誰", dept="oaa")
        self.assertTrue(out.startswith("【現任主管資料】"))
        self.assertIn("陳婉琪", out)
        self.assertIn("校長核定", out)  # 提醒不得從校長核定、簽名欄推定

    def test_keyword_style_tool_queries_use_the_user_question(self):
        # 工具參數只有關鍵字時，以使用者原本的問題判斷與查詢
        with self._call({"Who is the president of NTPU?": [ROSTER[0]]}):
            docs = core.current_official_docs("NTPU president 校長 國立臺北大學 校長室",
                                              ("Who is the president of NTPU?", "Who is the president of NTPU?"))
        self.assertEqual([d.metadata["url"] for d in docs], ["https://new.ntpu.edu.tw/president"])

    def test_unknown_people_and_broad_matches_add_nothing(self):
        too_many = {"主任是誰": ROSTER * 2}
        with self._call(too_many):
            self.assertEqual(core.current_official_docs("誰是宋明謙？"), [])
            self.assertEqual(core.current_official_docs("主任是誰"), [])
            self.assertEqual(core.current_official_docs("校長室電話"), [])

    def test_known_person_uses_the_roster_unit(self):
        with self._call():
            self.assertEqual(core.known_person_office("誰是陳宥杉"), ("vpa", "陳宥杉"))
            # 同一人兼任兩個單位：不指定處室，跨單位查
            self.assertEqual(core.known_person_office("陳婉琪是誰"), (None, "陳婉琪"))

    def test_mcp_off_or_down_changes_nothing(self):
        with patch.dict(os.environ, {"MCP_REGULATIONS": "0"}), patch.object(mcp_client, "call_tool") as call:
            self.assertEqual(core.current_officials_roster(), [])
            call.assert_not_called()
        with patch.object(mcp_client, "call_tool", side_effect=mcp_client.McpUnavailable("down")):
            self.assertEqual(core.current_officials_roster(), [])
            self.assertEqual(core.current_official_docs("現任校長是誰"), [])


if __name__ == "__main__":
    unittest.main()
