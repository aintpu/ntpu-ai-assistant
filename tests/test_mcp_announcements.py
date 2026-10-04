import os
import unittest
from unittest.mock import MagicMock, patch

# 與其他後端測試相同：不建 FAISS 索引、不連網路。
os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    import requests
    import agentic_v2_5_4high as core
    import mcp_client
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    core = None
    mcp_client = None
    _IMPORT_ERROR = str(exc)


SYNC = "2026-10-04T05:20:54.000Z"


def _item(n, unit="ord", url=True):
    return {
        "id": f"6abf42387085cb4f0c8185b{n}",
        "unit": unit,
        "postedBy": [unit],
        "title": f"研發處公告 {n}",
        "publishedAt": f"2026-10-0{n}T00:00:00.000Z",
        "snippet": f"公告 {n} 摘要",
        "attachmentCount": 0,
        "provenance": {"sourceUrl": f"https://new.ntpu.edu.tw/ord/news/{n}" if url else None},
    }


def _search(items, sync=SYNC):
    return {"items": items, "freshness": [{"unit": "ord", "lastSuccessAt": sync}], "warnings": []}


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class McpAnnouncementTests(unittest.TestCase):
    def setUp(self):
        core._reset_source_collector()
        self.env = patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": "1"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def _fake_tools(self, search_results):
        """依序回傳 search 結果；get_announcement 回傳全文。"""
        searches = list(search_results)
        calls = []

        def call_tool(name, args, **_):
            calls.append((name, args))
            if name == "search_announcements":
                return searches.pop(0)
            return {"announcement": {"bodyText": f"全文：{args['id']}"}}

        return call_tool, calls

    def test_uses_mcp_and_records_sync_time_and_sources(self):
        fake, calls = self._fake_tools([_search([_item(1), _item(2)])])
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_get_latest_news("國科會", dept="ord")
        self.assertIn("研發處公告 1", out)
        self.assertIn("【連結】：https://new.ntpu.edu.tw/ord/news/1", out)
        self.assertIn("全文：6abf42387085cb4f0c8185b1", out)
        self.assertEqual(calls[0], ("search_announcements", {"limit": 6, "unit": "ord", "keyword": "國科會"}))
        self.assertEqual(core.get_last_data_updated_at(), SYNC)
        titles = [c["title"] for c in core._source_ctx.candidates]
        self.assertEqual(titles, ["研發處公告 1", "研發處公告 2"])

    def test_maps_aia_department_codes_to_mcp_units(self):
        fake, calls = self._fake_tools([_search([_item(1, unit="op")])])
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            core.tool_get_latest_news("", dept="hr")
        self.assertEqual(calls[0][1], {"limit": 6, "unit": "op"})

    def test_retries_with_the_first_keyword_when_the_full_phrase_finds_nothing(self):
        fake, calls = self._fake_tools([_search([]), _search([_item(1)])])
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_get_latest_news("國科會 計畫 截止", dept="ord")
        self.assertIn("研發處公告 1", out)
        searches = [a for n, a in calls if n == "search_announcements"]
        self.assertEqual([s.get("keyword") for s in searches], ["國科會 計畫 截止", "國科會"])

    def test_falls_back_to_local_data_when_mcp_is_unavailable(self):
        with patch.object(mcp_client, "call_tool", side_effect=mcp_client.McpUnavailable("down")), \
                patch.object(core, "rank_news_for_query", return_value=[]) as local:
            out = core.tool_get_latest_news("國科會", dept="ord")
        local.assert_called_once()
        self.assertEqual(out, "查無最新消息。")
        self.assertIsNone(core.get_last_data_updated_at())

    def test_falls_back_when_mcp_finds_nothing(self):
        fake, _ = self._fake_tools([_search([])])
        with patch.object(mcp_client, "call_tool", side_effect=fake), \
                patch.object(core, "rank_news_for_query", return_value=[]) as local:
            core.tool_get_latest_news("找不到", dept="ord")
        local.assert_called_once()
        self.assertIsNone(core.get_last_data_updated_at())

    def test_offices_without_mcp_announcements_use_local_data(self):
        with patch.object(mcp_client, "call_tool") as tool, \
                patch.object(core, "latest_news_snippets", return_value=[]):
            core.tool_get_latest_news("", dept="pres")
        tool.assert_not_called()

    def test_switch_off_never_calls_mcp(self):
        with patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": "0"}), patch.object(mcp_client, "call_tool") as tool, \
                patch.object(core, "latest_news_snippets", return_value=[]):
            core.tool_get_latest_news("", dept="ord")
        tool.assert_not_called()

    def test_announcement_without_official_link_has_no_link_line(self):
        fake, _ = self._fake_tools([_search([_item(1, url=False)])])
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_get_latest_news("", dept="ord")
        self.assertNotIn("【連結】", out)

    def test_generic_words_and_office_names_are_not_used_as_filters(self):
        # 「教務處最新公告」不能變成要求公告裡一定出現「公告」「教務處」（會漏掉「【智財權宣導】轉知…」這類新公告）。
        for kw in ("公告", "最新公告", "教務處 最新 公告", "最近有什麼公告", "latest news"):
            self.assertEqual(core._news_search_terms(kw), [], kw)
        self.assertEqual(core._news_search_terms("研發處 國科會 計畫"), ["國科會", "計畫"])
        self.assertEqual(core._news_search_terms("圖書館 借書"), ["借書"])
        fake, calls = self._fake_tools([_search([_item(1)])])
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            core.tool_get_latest_news("教務處最新公告", dept="oaa")
        self.assertEqual(calls[0], ("search_announcements", {"limit": 6, "unit": "oaa"}))

    def test_dates_are_shown_in_taiwan_time(self):
        # 學校公告日期存成台灣 00:00＝前一天 16:00Z；直接取前 10 字會少一天。
        self.assertEqual(core._taipei_date("2026-10-01T16:00:00.000Z"), "2026-10-02")
        item = dict(_item(1), publishedAt="2026-10-01T16:00:00.000Z")
        fake, _ = self._fake_tools([_search([item])])
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            out = core.tool_get_latest_news("", dept="ord")
        self.assertIn("【日期】：2026-10-02", out)

    def test_sync_time_takes_the_earliest_across_calls(self):
        core._note_data_updated_at("2026-10-04T05:00:00Z")
        core._note_data_updated_at("2026-10-03T05:00:00Z")
        core._note_data_updated_at(None)
        self.assertEqual(core.get_last_data_updated_at(), "2026-10-03T05:00:00Z")
        core._reset_source_collector()
        self.assertIsNone(core.get_last_data_updated_at())


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class OfficeToolRuleTests(unittest.TestCase):
    """MCP 有公告的處室要能使用 get_latest_news；以前只有體育室、通識、語言中心能用。"""

    def test_offices_with_mcp_announcements_may_use_the_news_tool(self):
        with patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": "1"}):
            for dept in ("ord", "oaa", "osa", "hr", "oga", "lib", "cic", "oia"):
                self.assertTrue(core.mcp_news_available(dept), dept)
                rule = core.office_tool_rule(dept)
                self.assertIn("請用 get_latest_news", rule)
                self.assertNotIn("get_latest_news 皆【不可使用】", rule)
                self.assertIn("find_forms 皆【不可使用】", rule)

    def test_offices_without_mcp_announcements_keep_the_old_rule(self):
        with patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": "1"}):
            for dept in ("pres", "vpa", "vpad", "vpf", None):
                self.assertFalse(core.mcp_news_available(dept), dept)
                self.assertIn("get_latest_news 皆【不可使用】", core.office_tool_rule(dept))

    def test_switch_off_restores_the_old_rule_everywhere(self):
        with patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": "0"}):
            self.assertFalse(core.mcp_news_available("ord"))
            self.assertIn("get_latest_news 皆【不可使用】", core.office_tool_rule("ord"))


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class McpClientTests(unittest.TestCase):
    def _resp(self, status=200, body=None, bad_json=False):
        r = MagicMock(status_code=status)
        if bad_json:
            r.json.side_effect = ValueError("bad")
        else:
            r.json.return_value = body
        return r

    def test_returns_structured_content(self):
        body = {"result": {"structuredContent": {"items": []}}}
        with patch.object(requests, "post", return_value=self._resp(body=body)) as post:
            self.assertEqual(mcp_client.call_tool("search_announcements", {"limit": 1}), {"items": []})
        _, kwargs = post.call_args
        self.assertEqual(kwargs["timeout"], mcp_client.TIMEOUT_SECONDS)

    def test_errors_become_mcp_unavailable(self):
        cases = [
            self._resp(status=503),
            self._resp(bad_json=True),
            self._resp(body={"result": {"isError": True, "content": []}}),
            self._resp(body={"error": {"code": -32602}}),
        ]
        for resp in cases:
            with patch.object(requests, "post", return_value=resp):
                with self.assertRaises(mcp_client.McpUnavailable):
                    mcp_client.call_tool("search_announcements", {})
        with patch.object(requests, "post", side_effect=requests.Timeout()):
            with self.assertRaises(mcp_client.McpUnavailable):
                mcp_client.call_tool("search_announcements", {})

    def test_url_and_switch_come_from_environment(self):
        with patch.dict(os.environ, {"MCP_URL": "https://example.test/mcp", "MCP_ANNOUNCEMENTS": "off"}):
            self.assertEqual(mcp_client.mcp_url(), "https://example.test/mcp")
            self.assertFalse(mcp_client.announcements_enabled())
        with patch.dict(os.environ, {"MCP_ANNOUNCEMENTS": ""}):
            self.assertTrue(mcp_client.announcements_enabled())

    def test_every_mapped_unit_is_a_real_aia_department(self):
        for dept in mcp_client.DEPT_TO_MCP_UNIT:
            self.assertIn(dept, core.DEPT_NAMES)


if __name__ == "__main__":
    unittest.main()
