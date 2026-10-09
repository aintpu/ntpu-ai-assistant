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

    def test_also_searches_the_offices_site_pages(self):
        page = {"id": "6c" + "0" * 22, "unit": "osa", "title": "住宿服務組", "path": "/osa/housing",
                "updatedAt": "2026-09-01T00:00:00.000Z", "snippet": "宿舍申請",
                "provenance": {"sourceUrl": "https://new.ntpu.edu.tw/osa/housing"}}
        fake = FakeMcp({("search_pages", "宿舍"): [page]})
        orig = fake.__call__

        def call(name, args, **kw):
            if name == "get_page":
                fake.calls.append((name, dict(args)))
                return {"page": {"bodyText": "宿舍申請每學期於期末前開放"}}
            return orig(name, args, **kw)

        with patch.object(mcp_client, "call_tool", side_effect=call):
            out = core.tool_search_database("宿舍怎麼申請", dept="osa", keywords="宿舍")
        self.assertIn("住宿服務組", out)
        self.assertIn("宿舍申請每學期於期末前開放", out)
        self.assertIn("官網頁面", out)
        self.assertIn(("search_pages", {"keyword": "宿舍", "unit": "osa", "limit": 20}), fake.calls)

    def test_also_searches_announcement_attachments(self):
        # 資管所考科只寫在招生簡章 PDF 附件裡
        att = {"id": "a" * 32, "unit": "oaa", "postedBy": ["oaa"], "name": "115學年度碩士班一般入學簡章本.pdf",
               "url": "https://cms-carrier.ntpu.edu.tw/uploads/V2_115.pdf", "fileType": "pdf",
               "announcementId": "x", "announcementTitle": "本校115學年度碩士班一般入學考試簡章",
               "publishedAt": "2025-10-29T16:00:00.000Z", "method": "pdf", "extracted": True, "note": None,
               "pages": 90, "snippet": "…系所別 資訊管理研究所 二科任選考一科：一、計算機概論 二、管理資訊系統",
               "provenance": {"sourceUrl": "https://cms-carrier.ntpu.edu.tw/uploads/V2_115.pdf"}}
        fake = FakeMcp({("search_attachments", "資訊管理研究所"): [att]})
        orig = fake.__call__

        def call(name, args, **kw):
            if name == "get_attachment":
                fake.calls.append((name, dict(args)))
                return {"attachment": {"text": "【第 1 頁】\n國立臺北大學115學年度碩士班一般入學招生考試簡章"}}
            return orig(name, args, **kw)

        with patch.object(mcp_client, "call_tool", side_effect=call):
            out = core.tool_search_database("資訊管理研究所考試科目", dept="oaa", keywords="資訊管理研究所")
        self.assertIn("計算機概論", out)
        self.assertIn("115學年度碩士班一般入學簡章本.pdf", out)
        self.assertIn("公告附件（PDF）", out)
        self.assertIn("https://cms-carrier.ntpu.edu.tw/uploads/V2_115.pdf", out)
        self.assertIn(("get_attachment", {"id": "a" * 32}), fake.calls)

    def test_one_failing_tool_does_not_discard_the_others(self):
        # 正式 MCP 尚未登記某處室頁面時 search_pages 會回錯誤；法規結果仍要照常使用
        fake = FakeMcp({("search_regulations", "請假"): [_reg(1, "學生請假辦法")]})

        def call(name, args, **kw):
            if name == "search_pages":
                raise mcp_client.McpUnavailable("tool returned an error")
            return fake(name, args, **kw)

        with patch.object(mcp_client, "call_tool", side_effect=call):
            out = core.tool_search_database("學生請假", dept="osa", keywords="請假")
        self.assertIn("學生請假辦法", out)
        self.local_mock.assert_not_called()

    def test_language_center_has_no_page_unit(self):
        # lc 沒有官網內容頁來源；傳進 search_pages 會讓工具回錯誤
        self.assertNotIn("lc", mcp_client.DEPT_TO_MCP_PAGE_UNIT)

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
        # 圖書館本機也查不到時，再查全校已收錄資料（老師建議 一-2-(1)）
        with patch.object(mcp_client, "call_tool", side_effect=FakeMcp({})):
            core.tool_search_database("續借", dept="lib", keywords="續借")
        self.assertEqual(self._local_depts(), ["lib", None])
        self.local_mock.reset_mock()
        with patch.object(mcp_client, "call_tool", side_effect=mcp_client.McpUnavailable("down")):
            core.tool_search_database("續借", dept="lib", keywords="續借")
        self.assertEqual(self._local_depts(), ["lib", None])
        self.assertIsNone(core.get_last_data_updated_at())

    def test_falls_back_when_mcp_evidence_does_not_match_the_question(self):
        fake = FakeMcp({("search_faqs", "停車"): [_faq(1, "校園無線網路設定", "eduroam")]})
        with patch.object(mcp_client, "call_tool", side_effect=fake):
            core.tool_search_database("汽車停車證怎麼申請", dept="lib", keywords="停車")
        self.assertEqual(self._local_depts(), ["lib", None])
        self.assertIsNone(core.get_last_data_updated_at())

    def test_global_fallback_only_when_the_office_lacks_evidence(self):
        """老師建議 一-2-(1)：指定處室有足夠證據就不補查；不足時補查全校並註明。"""
        from langchain_core.documents import Document
        doc = Document(page_content="宿舍申請說明", metadata={"title": "宿舍申請", "dept": "osa"})
        ok = type("E", (), {"sufficient": True, "to_dict": lambda self: {}})()
        bad = type("E", (), {"sufficient": False, "to_dict": lambda self: {}})()
        self.local_mock.return_value = [doc]
        with patch.object(mcp_client, "call_tool", side_effect=FakeMcp({})), \
                patch.object(core, "check_evidence_sufficiency", return_value=ok):
            out = core.tool_search_database("宿舍申請", dept="osa", keywords="")
        self.assertEqual(self._local_depts(), ["osa"])
        self.assertNotIn("全校已收錄資料", out)
        self.local_mock.reset_mock()
        with patch.object(mcp_client, "call_tool", side_effect=FakeMcp({})), \
                patch.object(core, "check_evidence_sufficiency", side_effect=[bad, ok]):
            out = core.tool_search_database("宿舍申請", dept="oaa", keywords="")
        self.assertEqual(self._local_depts(), ["oaa", None])
        self.assertIn("教務處的資料沒有足夠證據，以下為全校已收錄資料的查詢結果", out)
        self.assertIn("宿舍申請說明", out)

    def _local_depts(self):
        return [c.kwargs.get("dept") for c in self.local_mock.call_args_list]

    def test_offices_not_fully_covered_by_mcp_stay_local(self):
        for dept in ("ope", "ge", "lc", "pres", None):
            self.assertFalse(core.mcp_records_available(dept), dept)
        with patch.object(mcp_client, "call_tool", side_effect=FakeMcp({})) as tool:
            core.tool_search_database("選課", dept="ge", keywords="選課")
        # 通識中心本身不查 MCP；本機證據不足時補查全校，那時才不指定處室查 MCP
        self.assertFalse([c for c in tool.call_args_list if "unit" in c.args[1]])
        self.assertEqual(self._local_depts(), ["ge", None])

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

    def test_english_words_are_not_used_for_grounding(self):
        # 「the president of NTPU?」曾因英文標題含 NTPU 被分到學務處
        from langchain_core.documents import Document
        with patch.object(core.INDEX, "docs_zh", [Document(page_content="x", metadata={"title": "NTPU Student Handbook", "dept": "osa"})]):
            core._title_index = None
            self.assertIsNone(core.known_topic_office("the president of NTPU?"))
        core._title_index = None

    def test_person_questions_use_the_document_that_states_who_they_are(self):
        from langchain_core.documents import Document
        docs = [Document(page_content="林道通校長致詞", metadata={"title": "北鼎聯賽圓滿落幕", "dept": "ope"})] * 7 + [
            Document(page_content="林道通校長授旗", metadata={"title": "校長授旗勉勵代表隊", "dept": "ope"}),
            Document(page_content="Q: 現任校長是誰？ A: 林道通", metadata={"title": "現任校長是誰？", "dept": "pres"}),
        ]
        with patch.object(core.INDEX, "docs_zh", docs):
            core._content_index = None
            self.assertEqual(core.known_person_office("who is 林道通"), ("pres", "林道通"))
            self.assertEqual(core.known_person_office("林道通是誰"), ("pres", "林道通"))
            self.assertIsNone(core.known_person_office("誰是宋明謙？"))
            self.assertIsNone(core.known_person_office("林道通的研究領域"))  # 不是問人名的句型
            # 問職位不是問人名：拆開後的「學歷」不是姓名，不能拿來比對
            self.assertIsNone(core.known_person_office("現任行政副校長是誰？學歷？"))
        # 兩個單位都寫明身分（曾任主任秘書、現任學術副校長）：不指定處室，跨單位查詢
        docs2 = [Document(page_content="現任：陳宥杉", metadata={"title": "歷屆主任秘書有哪些人？現任是誰？", "dept": "os"}),
                 Document(page_content="A: 陳宥杉", metadata={"title": "現任學術副校長是誰？", "dept": "vpa"})]
        with patch.object(core.INDEX, "docs_zh", docs2):
            core._content_index = None
            self.assertEqual(core.known_person_office("誰是陳宥杉"), (None, "陳宥杉"))
            # 不指定處室時，範圍判斷不能因為查處室名稱而出錯（曾造成 KeyError: None）
            core._title_index = None
            scope = core.ground_scope_in_data(self._out(), "誰是陳宥杉")
            self.assertEqual((scope.status, scope.office_hint), ("IN_SCOPE", None))
        core._content_index = None
        core._title_index = None
        core._content_index = None

    def test_in_scope_decisions_are_untouched(self):
        from conversation_guardrail import ScopeDecision
        scope = ScopeDecision("IN_SCOPE", "lib", 0.9, "")
        self.assertIs(core.ground_scope_in_data(scope, "信義會館"), scope)


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class ScopeMajorityVoteTests(unittest.TestCase):
    """模型判 OUT_OF_SCOPE 時再問兩次取多數決，降低同一題結果不一致。"""

    def _run(self, outputs, query="期中考是哪一週"):
        from conversation_guardrail import ScopeDecision
        answers = iter(outputs)
        calls = []

        def fake(**kwargs):
            calls.append(kwargs["standalone_query"])
            status = next(answers)
            return ScopeDecision(status, "oaa" if status == "IN_SCOPE" else None, 0.9, "")

        with patch.object(core, "run_scope_guardrail", side_effect=fake), \
                patch.object(core, "known_topic_office", return_value=None):
            scope = core.decide_scope(query, {"raw_query": query}, query)
        return scope, calls

    def test_in_scope_is_accepted_without_extra_calls(self):
        scope, calls = self._run(["IN_SCOPE"])
        self.assertEqual((scope.status, len(calls)), ("IN_SCOPE", 1))

    def test_a_lone_out_of_scope_vote_is_outvoted(self):
        scope, calls = self._run(["OUT_OF_SCOPE", "IN_SCOPE", "IN_SCOPE"])
        self.assertEqual((scope.status, scope.office_hint, len(calls)), ("IN_SCOPE", "oaa", 3))

    def test_majority_out_of_scope_stays_blocked(self):
        scope, calls = self._run(["OUT_OF_SCOPE", "IN_SCOPE", "OUT_OF_SCOPE"], query="什麼是量子力學")
        self.assertEqual((scope.status, len(calls)), ("OUT_OF_SCOPE", 3))

    def test_rule_based_blocks_are_not_revoted(self):
        for query in ("台大的宿舍怎麼申請", "今天台北天氣如何"):
            scope, calls = self._run(["OUT_OF_SCOPE"], query=query)
            self.assertEqual((scope.status, len(calls)), ("OUT_OF_SCOPE", 1), query)


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class KnownPersonNoClarificationTests(unittest.TestCase):
    def test_known_person_question_is_not_sent_back_for_clarification(self):
        import pathlib
        src = (pathlib.Path(__file__).resolve().parents[1] / "agentic_v2_5_4high.py").read_text(encoding="utf-8")
        self.assertIn("resolution.ambiguity and not known_person", src)
