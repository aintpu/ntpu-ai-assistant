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


SYNC = "2026-10-04T06:41:43.416Z"
LOCAL = "本機索引結果"


def _faq(n, question, answer_hint="", url=None, unit="library"):
    return {
        "id": f"LIB-{n:03d}",
        "unit": unit,
        "question": question,
        "topic": None,
        "division": None,
        "sourceDate": "2026-10-01",
        "sourceName": "圖書館常見問答",
        "snippet": answer_hint,
        "provenance": {"sourceUrl": url},
    }


def _reg(n, title, full=True, file_url=None, unit="osa"):
    return {
        "id": f"{n:024x}",
        "unit": unit,
        "owner": "學生事務處",
        "title": title,
        "hasFullText": full,
        "fileUrl": file_url,
        "tags": [],
        "updatedDate": "2026-09-01",
        "sourceName": "學務處法規",
        "snippet": title,
        "provenance": {"sourceUrl": None},
    }


def _result(items):
    return {"items": items, "count": len(items), "noResult": not items,
            "freshness": [{"unit": "x", "lastSuccessAt": SYNC}], "warnings": []}


class FakeMcp:
    """依 (工具, 關鍵字) 回傳結果；get_* 回傳全文。"""

    def __init__(self, searches):
        self.searches = searches
        self.calls = []

    def __call__(self, name, args, **_):
        self.calls.append((name, dict(args)))
        if name == "get_faq":
            return {"faq": {"answer": f"回答：{args['id']}", "details": ""}}
        if name == "get_regulation":
            return {"regulation": {"bodyText": f"條文：{args['id']}"}}
        return _result(self.searches.get((name, args.get("keyword")), []))


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class McpRecordTests(unittest.TestCase):
    def setUp(self):
        core._reset_source_collector()
        self.env = patch.dict(os.environ, {"MCP_REGULATIONS": "1"})
        self.env.start()
        self.local = patch.object(core, "retrieve_and_rerank", return_value=[])
        self.local_mock = self.local.start()

    def tearDown(self):
        self.local.stop()
        self.env.stop()

    def test_switch_is_off_by_default(self):
        with patch.dict(os.environ, {"MCP_REGULATIONS": ""}):
            self.assertFalse(mcp_client.records_enabled())
            self.assertFalse(core.mcp_records_available("lib"))
        self.assertTrue(core.mcp_records_available("lib"))

    def test_uses_mcp_faqs_and_records_sources(self):
        fake = FakeMcp({("search_faqs", "續借"): [_faq(1, "圖書如何續借？", url="https://library.ntpu.edu.tw/faq/1")]})
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_search_database("圖書館的書要怎麼續借", dept="lib", keywords="續借")
        self.assertIn("圖書如何續借？", out)
        self.assertIn("回答：LIB-001", out)
        self.assertIn("https://library.ntpu.edu.tw/faq/1", out)
        self.assertIn(("search_faqs", {"keyword": "續借", "unit": "library", "limit": 20}), fake.calls)
        self.assertIn(("search_regulations", {"keyword": "續借", "unit": "library", "limit": 20}), fake.calls)
        self.local_mock.assert_not_called()
        self.assertEqual(core.get_last_data_updated_at(), SYNC)
        self.assertEqual([c["title"] for c in core._source_ctx.candidates], ["圖書如何續借？"])

    def test_also_searches_the_offices_announcements(self):
        # 成績單自動列印機台的位置只寫在教務處公告裡，不在法規或常見問答。
        news = {"id": "6a" + "0" * 22, "unit": "oaa", "title": "成績單及證明文件申請管道說明",
                "publishedAt": "2025-04-13T16:00:00.000Z", "snippet": "成績單自動列印服務系統機器",
                "provenance": {"sourceUrl": "https://new.ntpu.edu.tw/oaa/news/x"}}
        fake = FakeMcp({("search_announcements", "成績單"): [news]})
        orig = fake.__call__

        def call(name, args, **kw):
            if name == "get_announcement":
                fake.calls.append((name, dict(args)))
                return {"announcement": {"bodyText": "機器擺放位置於台北校區教學大樓1樓"}}
            return orig(name, args, **kw)

        with patch.object(mcp_client, "call_tool", side_effect=call):
            out = core.tool_search_database("成績單列印機台在哪裡", dept="oaa", keywords="成績單")
        self.assertIn("成績單及證明文件申請管道說明", out)
        self.assertIn("機器擺放位置於台北校區教學大樓1樓", out)
        self.assertIn("公告（2025-04-14）", out)
        self.assertIn(("search_announcements", {"keyword": "成績單", "unit": "oaa", "limit": 20}), fake.calls)
        self.assertIn(("get_announcement", {"id": news["id"], "unit": "oaa"}), fake.calls)

    def test_announcements_switch_off_skips_announcement_search(self):
        fake = FakeMcp({})
        with patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": "0"}), patch.object(mcp_client, "call_tool", side_effect=fake):
            core.tool_search_database("成績單", dept="oaa", keywords="成績單")
        self.assertFalse(any(n == "search_announcements" for n, _ in fake.calls))

    def test_falls_back_to_single_keywords_and_ranks_by_matches(self):
        fake = FakeMcp({
            ("search_regulations", "請假"): [_reg(1, "學生請假辦法"), _reg(2, "教職員請假須知")],
            ("search_regulations", "學生"): [_reg(1, "學生請假辦法"), _reg(3, "學生獎懲辦法")],
        })
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_search_database("學生請假要怎麼辦", dept="osa", keywords="請假 學生")
        keywords = [a["keyword"] for n, a in fake.calls if n == "search_regulations"]
        self.assertEqual(keywords[0], "請假 學生")
        self.assertEqual(sorted(keywords[1:]), ["學生", "請假"])
        self.assertLess(out.index("學生請假辦法"), out.index("教職員請假須知"))
        # 學務處在 MCP 沒有常見問答
        self.assertFalse(any(n == "search_faqs" for n, _ in fake.calls))

    def test_catalog_only_regulation_points_to_the_official_file(self):
        fake = FakeMcp({("search_regulations", "獎學金"): [
            _reg(1, "研究生獎學金辦法", full=False, file_url="https://new.ntpu.edu.tw/x.pdf", unit="ord")]})
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_search_database("研究生獎學金辦法", dept="ord", keywords="獎學金")
        self.assertIn("無條文全文", out)
        self.assertIn("https://new.ntpu.edu.tw/x.pdf", out)

    def test_record_without_link_names_the_source_in_text(self):
        fake = FakeMcp({("search_faqs", "續借"): [_faq(1, "圖書如何續借？")]})
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_search_database("續借", dept="lib", keywords="續借")
        self.assertIn("【來源網址】\n", out)
        self.assertIn("來源：圖書館常見問答", out)

    def test_falls_back_to_local_when_mcp_finds_nothing_or_is_down(self):
        with patch.object(mcp_client, "call_tool", side_effect=FakeMcp({})):
            core.tool_search_database("續借", dept="lib", keywords="續借")
        self.local_mock.assert_called_once()
        self.local_mock.reset_mock()
        with patch.object(mcp_client, "call_tool", side_effect=mcp_client.McpUnavailable("down")):
            core.tool_search_database("續借", dept="lib", keywords="續借")
        self.local_mock.assert_called_once()
        self.assertIsNone(core.get_last_data_updated_at())

    def test_falls_back_when_mcp_evidence_does_not_match_the_question(self):
        fake = FakeMcp({("search_faqs", "停車"): [_faq(1, "校園無線網路設定", "eduroam")]})
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            core.tool_search_database("汽車停車證怎麼申請", dept="lib", keywords="停車")
        self.local_mock.assert_called_once()
        self.assertIsNone(core.get_last_data_updated_at())

    def test_offices_not_fully_covered_by_mcp_stay_local(self):
        for dept in ("ope", "ge", "lc", "pres", None):
            self.assertFalse(core.mcp_records_available(dept), dept)
        with patch.object(mcp_client, "call_tool") as tool:
            core.tool_search_database("選課", dept="ge", keywords="選課")
        tool.assert_not_called()

    def test_missing_keywords_or_switch_off_never_calls_mcp(self):
        with patch.object(mcp_client, "call_tool") as tool:
            core.tool_search_database("續借", dept="lib", keywords="")
            with patch.dict(os.environ, {"MCP_REGULATIONS": "0"}):
                core.tool_search_database("續借", dept="lib", keywords="續借")
        tool.assert_not_called()

    def test_keyword_parsing(self):
        self.assertEqual(core._record_search_terms("校友證，補發、 校友證"), ["校友證", "補發"])
        self.assertEqual(core._record_search_terms("a b c d e f"), ["a", "b", "c", "d", "e"])

    def test_every_mapped_unit_is_a_real_aia_department(self):
        for dept in mcp_client.DEPT_TO_MCP_RECORD_UNITS:
            self.assertIn(dept, core.DEPT_NAMES)


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class GroundedScopeTests(unittest.TestCase):
    """模型把本校資料裡的名詞（信義會館、北聯大…）誤判成外部機構時，用知識庫標題改判。"""

    def setUp(self):
        from langchain_core.documents import Document
        docs = [
            Document(page_content="x", metadata={"title": "信義會館住宿有什麼規定？", "dept": "eec"}),
            Document(page_content="x", metadata={"title": "北聯大計畫有哪些類型？補助多少？", "dept": "ord"}),
        ]
        self.patch = patch.object(core.INDEX, "docs_zh", docs)
        self.patch.start()
        core._title_index = None

    def tearDown(self):
        self.patch.stop()
        core._title_index = None

    def _out(self):
        from conversation_guardrail import ScopeDecision
        return ScopeDecision("OUT_OF_SCOPE", None, 1.0, "模型判斷為外部機構")

    def test_known_topic_overrides_model_out_of_scope(self):
        scope = core.ground_scope_in_data(self._out(), "住信義會館有哪些規定")
        self.assertEqual((scope.status, scope.office_hint), ("IN_SCOPE", "eec"))
        scope = core.ground_scope_in_data(self._out(), "北聯大計畫可以補助多少錢")
        self.assertEqual((scope.status, scope.office_hint), ("IN_SCOPE", "ord"))

    def test_rule_based_blocks_are_never_overridden(self):
        # 外校與已知無關意圖：即使標題剛好有相同字詞也不放行
        for q in ("淡江大學的信義會館", "政大的北聯大計畫"):
            self.assertEqual(core.ground_scope_in_data(self._out(), q).status, "OUT_OF_SCOPE", q)

    def test_unknown_topics_and_short_words_stay_blocked(self):
        for q in ("什麼是量子力學", "會館在哪", "幫我寫一首詩"):
            self.assertEqual(core.ground_scope_in_data(self._out(), q).status, "OUT_OF_SCOPE", q)

    def test_in_scope_decisions_are_untouched(self):
        from conversation_guardrail import ScopeDecision
        scope = ScopeDecision("IN_SCOPE", "lib", 0.9, "")
        self.assertIs(core.ground_scope_in_data(scope, "信義會館"), scope)
