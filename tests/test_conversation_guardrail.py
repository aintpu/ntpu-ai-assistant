import json
import unittest
from types import SimpleNamespace

from conversation_guardrail import (
    ConversationResolution,
    ConversationState,
    build_updated_state,
    check_evidence_sufficiency,
    detect_explicit_unsupported_intent,
    detect_service_entity_conflict,
    resolution_scope_context,
    resolve_conversation,
    run_scope_guardrail,
    select_office,
)


class FakeCompleter:
    def __init__(self, outputs):
        self.outputs = list(outputs)

    def __call__(self, messages, **kwargs):
        if not self.outputs:
            raise AssertionError("fake completion queue is empty")
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        return json.dumps(output, ensure_ascii=False) if isinstance(output, dict) else output


def resolver_output(**overrides):
    result = {
        "is_followup": True,
        "topic_changed": False,
        "standalone_query": "外語能力畢業門檻：要幾分",
        "inherited_office": "lc",
        "topic": "外語能力畢業門檻",
        "ambiguity": False,
        "ambiguity_reason": None,
        "confidence": 0.94,
    }
    result.update(overrides)
    return result


class ConversationGuardrailTests(unittest.TestCase):
    def test_supported_service_entity_is_not_blocked(self):
        self.assertIsNone(detect_service_entity_conflict("國立臺北大學宿舍住宿管理規定"))
        self.assertIsNone(detect_service_entity_conflict("NTPU 的宿舍申請流程"))

    def test_competing_entity_alias_is_blocked_before_followup_inheritance(self):
        self.assertEqual(detect_service_entity_conflict("那請問台灣大學的呢"), "台灣大學")
        self.assertEqual(detect_service_entity_conflict("不是是要台大"), "台大")

    def test_generic_organization_entity_is_blocked(self):
        self.assertEqual(detect_service_entity_conflict("某某銀行的學生貸款規定"), "某某銀行")
        self.assertEqual(detect_service_entity_conflict("National Taiwan University dorm rules"), "National Taiwan University")

    def test_scope_guardrail_entity_conflict_wins_over_model_in_scope(self):
        def should_not_complete(*args, **kwargs):
            raise AssertionError("lexical entity boundary should run before the LLM scope classifier")

        scope = run_scope_guardrail(
            "國立臺北大學宿舍住宿管理規定：那請問台灣大學的呢",
            {
                "raw_query": "那請問台灣大學的呢",
                "active_office": "osa",
                "active_topic": "國立臺北大學宿舍住宿管理規定",
            },
            should_not_complete,
            retries=0,
        )
        self.assertEqual(scope.status, "OUT_OF_SCOPE")
        self.assertTrue(scope.entity_conflict)
        self.assertEqual(scope.entity_hint, "台灣大學")

    def test_unrelated_short_question_cannot_reuse_previous_context(self):
        scope = run_scope_guardrail(
            "國立臺北大學宿舍住宿管理規定：那附近的餐廳呢",
            {
                "raw_query": "那附近的餐廳呢",
                "active_office": "osa",
                "active_topic": "國立臺北大學宿舍住宿管理規定",
            },
            FakeCompleter([
                {
                    "status": "IN_SCOPE",
                    "office_hint": "osa",
                    "confidence": 0.96,
                    "reason": "沿用上一輪宿舍主題",
                },
            ]),
            retries=0,
        )
        self.assertEqual(scope.status, "OUT_OF_SCOPE")
        self.assertFalse(scope.entity_conflict)
        self.assertIn("餐廳或美食推薦", scope.reason)

    def test_scope_classifier_failure_does_not_restore_old_context(self):
        def failing_complete(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        scope = run_scope_guardrail(
            "國立臺北大學宿舍住宿管理規定：明天台北會下雨嗎？",
            {
                "raw_query": "明天台北會下雨嗎？",
                "active_office": "osa",
                "active_topic": "國立臺北大學宿舍住宿管理規定",
            },
            failing_complete,
            retries=0,
        )
        self.assertEqual(scope.status, "OUT_OF_SCOPE")
        self.assertIsNone(scope.office_hint)

    def test_unrelated_fresh_questions_are_blocked_even_if_model_says_in_scope(self):
        def overoptimistic_model(*args, **kwargs):
            return json.dumps({
                "status": "IN_SCOPE",
                "office_hint": "osa",
                "confidence": 0.99,
                "reason": "模型錯誤放行",
            }, ensure_ascii=False)

        for query in (
            "明天台北會下雨嗎？",
            "請推薦附近的餐廳",
            "比特幣現在多少錢？",
            "幫我寫一段 Python 程式",
            "台北大學附近的餐廳",
            "NTPU 校園天氣如何？",
        ):
            with self.subTest(query=query):
                scope = run_scope_guardrail(query, {}, overoptimistic_model, retries=0)
                self.assertEqual(scope.status, "OUT_OF_SCOPE")
                self.assertIsNone(scope.office_hint)

    def test_explicit_unrelated_intents_are_detected_without_a_model(self):
        cases = {
            "明天台北會下雨嗎？": "天氣或氣象",
            "請推薦附近的餐廳": "餐廳或美食推薦",
            "比特幣現在多少錢？": "投資或市場行情",
            "幫我寫一段 Python 程式": "程式撰寫",
        }
        for query, expected in cases.items():
            with self.subTest(query=query):
                self.assertEqual(detect_explicit_unsupported_intent(query), expected)

    def test_natural_hr_paraphrases_are_not_treated_as_unrelated(self):
        def failing_complete(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        for query in (
            "行政人員的午休時間是幾點到幾點",
            "特休幾天",
            "特別休假有幾日",
        ):
            with self.subTest(query=query):
                scope = run_scope_guardrail(query, {}, failing_complete, retries=0)
                self.assertEqual(scope.status, "IN_SCOPE")
                self.assertEqual(scope.office_hint, "hr")

    def test_student_group_insurance_is_routed_even_if_model_is_overly_conservative(self):
        scope = run_scope_guardrail(
            "115至116學年度學生團體保險的身故保險金是多少？",
            {},
            FakeCompleter([{
                "status": "OUT_OF_SCOPE",
                "office_hint": None,
                "confidence": 0.91,
                "reason": "模型誤判為一般保險問題",
            }]),
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "osa")

    def test_high_confidence_semantic_office_can_cover_unknown_paraphrase(self):
        scope = run_scope_guardrail(
            "同仁中午可以休息多久",
            {},
            FakeCompleter([{
                "status": "IN_SCOPE",
                "office_hint": "hr",
                "confidence": 0.93,
                "reason": "行政人員勤休問題",
            }]),
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "hr")

    def test_semantic_scope_without_office_or_confidence_remains_blocked(self):
        cases = (
            {"status": "IN_SCOPE", "office_hint": None, "confidence": 0.99, "reason": "沒有處室"},
            {"status": "IN_SCOPE", "office_hint": "hr", "confidence": 0.60, "reason": "低信心"},
        )
        for output in cases:
            with self.subTest(output=output):
                scope = run_scope_guardrail(
                    "這是一個沒有關鍵詞的問題",
                    {},
                    FakeCompleter([output]),
                    retries=0,
                )
                self.assertEqual(scope.status, "OUT_OF_SCOPE")
                self.assertIsNone(scope.office_hint)

    def test_followup_short_query_not_out_of_scope(self):
        state = ConversationState(
            conversation_id="c1",
            active_office="lc",
            active_topic="外語能力畢業門檻",
        )
        completer = FakeCompleter([
            resolver_output(),
            {"status": "IN_SCOPE", "office_hint": "lc", "confidence": 0.96, "reason": "語言中心主題"},
        ])
        resolution = resolve_conversation("要幾分", [], state, completer, retries=0)
        scope = run_scope_guardrail(
            resolution.standalone_query,
            {"active_office": state.active_office, "active_topic": state.active_topic},
            completer,
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertNotEqual(scope.status, "OUT_OF_SCOPE")

    def test_followup_rewrites_with_previous_topic(self):
        state = ConversationState(active_topic="外語能力畢業門檻")
        completer = FakeCompleter([resolver_output()])
        result = resolve_conversation("要幾分", [], state, completer, retries=0)
        self.assertEqual(result.standalone_query, "外語能力畢業門檻：要幾分")
        self.assertTrue(result.is_followup)

    def test_verified_compact_value_reply_inherits_topic_and_office(self):
        state = ConversationState(
            conversation_id="hr-years-1",
            active_office="hr",
            active_topic="行政人員一年有多少天特休？",
            scope_verified=True,
            previous_user_query="行政人員一年有多少天特休？",
            previous_standalone_query="行政人員一年有多少天特休？",
        )
        completer = FakeCompleter([
            resolver_output(
                is_followup=False,
                topic_changed=True,
                standalone_query="我5年",
                inherited_office=None,
                topic="我5年",
                confidence=0.72,
            ),
            {
                "status": "OUT_OF_SCOPE",
                "office_hint": None,
                "confidence": 0.90,
                "reason": "模型只看到簡短數值",
            },
        ])

        resolution = resolve_conversation("我5年", [], state, completer, retries=0)
        self.assertTrue(resolution.is_followup)
        self.assertFalse(resolution.topic_changed)
        self.assertEqual(resolution.inherited_office, "hr")
        self.assertEqual(
            resolution.standalone_query,
            "行政人員一年有多少天特休？：我5年",
        )

        scope = run_scope_guardrail(
            resolution.standalone_query,
            state.to_dict() | {"raw_query": "我5年"},
            completer,
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "hr")

    def test_compact_value_reply_needs_verified_supported_context(self):
        state = ConversationState(
            active_office="hr",
            active_topic="行政人員一年有多少天特休？",
            scope_verified=False,
        )
        resolution = resolve_conversation(
            "我5年",
            [],
            state,
            FakeCompleter([resolver_output(
                is_followup=False,
                topic_changed=False,
                standalone_query="我5年",
                inherited_office=None,
                topic="我5年",
            )]),
            retries=0,
        )
        self.assertFalse(resolution.is_followup)
        self.assertEqual(resolution.standalone_query, "我5年")

    def test_common_compact_answers_are_resolved_as_verified_followups(self):
        cases = (
            ("600分", "lc", "大學英文免修門檻"),
            ("2學分", "ge", "通識學分抵免"),
            ("我是聘僱人員", "hr", "行政人員特別休假"),
            ("我是十年", "hr", "行政人員特別休假"),
        )
        for query, office, topic in cases:
            with self.subTest(query=query):
                state = ConversationState(
                    active_office=office,
                    active_topic=topic,
                    scope_verified=True,
                )
                resolution = resolve_conversation(
                    query,
                    [],
                    state,
                    FakeCompleter([resolver_output(
                        is_followup=False,
                        topic_changed=True,
                        standalone_query=query,
                        inherited_office=None,
                        topic=query,
                    )]),
                    retries=0,
                )
                self.assertTrue(resolution.is_followup)
                self.assertFalse(resolution.topic_changed)
                self.assertEqual(resolution.inherited_office, office)
                self.assertEqual(resolution.standalone_query, f"{topic}：{query}")

    def test_self_contained_supported_query_drops_hidden_stale_condition(self):
        state = ConversationState(
            active_office="hr",
            active_topic="行政人員一年有多少天特休？",
            scope_verified=True,
            previous_user_query="我是7年",
            previous_standalone_query="行政人員一年有多少天特休？：我是7年",
        )
        query = "行政人員一年有多少天特休？"
        resolution = resolve_conversation(
            query,
            [],
            state,
            FakeCompleter([resolver_output(
                is_followup=True,
                topic_changed=False,
                standalone_query="行政人員一年有多少天特休？：年資七年",
                inherited_office="hr",
                topic="行政人員一年有多少天特休？",
            )]),
            retries=0,
        )
        self.assertFalse(resolution.is_followup)
        self.assertFalse(resolution.topic_changed)
        self.assertIsNone(resolution.inherited_office)
        self.assertEqual(resolution.standalone_query, query)

    def test_unrelated_numeric_query_still_cannot_inherit_verified_context(self):
        def should_not_complete(*args, **kwargs):
            raise AssertionError("explicit unsupported intent should run before context inheritance")

        scope = run_scope_guardrail(
            "行政人員一年有多少天特休？：比特幣5年走勢",
            {
                "raw_query": "比特幣5年走勢",
                "active_office": "hr",
                "active_topic": "行政人員一年有多少天特休？",
                "scope_verified": True,
            },
            should_not_complete,
            retries=0,
        )
        self.assertEqual(scope.status, "OUT_OF_SCOPE")
        self.assertIn("投資或市場行情", scope.reason)

    def test_followup_inherits_office(self):
        state = ConversationState(active_office="lc", active_topic="外語能力畢業門檻")
        resolution = resolver_output()
        from conversation_guardrail import ConversationResolution, ScopeDecision

        office = select_office(
            ConversationResolution.from_value(resolution),
            ScopeDecision("IN_SCOPE", None, 0.95, "same topic"),
            state,
            threshold=0.80,
        )
        self.assertEqual(office, "lc")

    def test_topic_shift_forces_reroute(self):
        state = ConversationState(active_office="lc", active_topic="外語能力畢業門檻")
        completer = FakeCompleter([
            resolver_output(
                is_followup=False,
                topic_changed=True,
                standalone_query="宿舍申請流程",
                inherited_office=None,
                topic="住宿申請",
                confidence=0.91,
            ),
            {"status": "IN_SCOPE", "office_hint": "osa", "confidence": 0.93, "reason": "學務處主題"},
        ])
        resolution = resolve_conversation("宿舍申請流程", [], state, completer, retries=0)
        scope = run_scope_guardrail(resolution.standalone_query, state.to_dict(), completer, retries=0)
        office = select_office(resolution, scope, state, threshold=0.80)
        self.assertTrue(resolution.topic_changed)
        self.assertEqual(office, "osa")

    def test_ambiguous_followup_not_out_of_scope(self):
        state = ConversationState(active_office="lc", active_topic="語言檢定")
        completer = FakeCompleter([
            resolver_output(
                standalone_query="語言檢定：這個呢",
                topic="語言檢定",
                ambiguity=True,
                ambiguity_reason="缺少檢定名稱",
            ),
            {"status": "AMBIGUOUS", "office_hint": "lc", "confidence": 0.50, "reason": "缺少檢定名稱"},
        ])
        resolution = resolve_conversation("這個呢", [], state, completer, retries=0)
        scope = run_scope_guardrail(resolution.standalone_query, state.to_dict(), completer, retries=0)
        self.assertEqual(scope.status, "AMBIGUOUS")
        self.assertNotEqual(scope.status, "OUT_OF_SCOPE")

    def test_resolver_failure_uses_active_topic_fallback(self):
        state = ConversationState(
            active_office="lc",
            active_topic="外語能力畢業門檻",
            previous_standalone_query="外語能力畢業門檻",
        )

        def failing_complete(*args, **kwargs):
            raise RuntimeError("resolver unavailable")

        result = resolve_conversation("要幾分", [], state, failing_complete, retries=0)
        self.assertTrue(result.is_followup)
        self.assertIn("外語能力畢業門檻", result.standalone_query)
        self.assertEqual(result.inherited_office, "lc")

    def test_general_affairs_question_routes_to_oga(self):
        def failing_complete(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        scope = run_scope_guardrail(
            "學雜費繳費單要去哪裡查詢與繳納？",
            {},
            failing_complete,
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "oga")

    def test_general_fitness_question_stays_in_scope(self):
        def failing_complete(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        scope = run_scope_guardrail(
            "如何安排健身與熱身？",
            {},
            failing_complete,
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "ope")

    def test_general_affairs_venue_form_beats_generic_venue_keyword(self):
        def failing_complete(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        scope = run_scope_guardrail(
            "校內或校外單位的場地借用申請表在哪裡下載？",
            {},
            failing_complete,
            retries=0,
        )
        self.assertEqual(scope.office_hint, "oga")

    def test_general_affairs_priority_overrides_conflicting_model_guess(self):
        completer = FakeCompleter([{
            "status": "IN_SCOPE",
            "office_hint": "oaa",
            "confidence": 0.92,
            "reason": "模型誤判為教務處學雜費業務",
        }])
        scope = run_scope_guardrail(
            "學雜費繳費單要去哪裡查詢與繳納？",
            {},
            completer,
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "oga")

    def test_similar_language_center_topics_do_not_mix(self):
        state = ConversationState(active_office="lc", active_topic="大學英文免修")
        completer = FakeCompleter([
            resolver_output(
                standalone_query="大學英文免修：需要幾分",
                topic="大學英文免修",
            ),
            {"status": "IN_SCOPE", "office_hint": "lc", "confidence": 0.94, "reason": "語言中心主題"},
        ])
        result = resolve_conversation("需要幾分", [], state, completer, retries=0)
        scope = run_scope_guardrail(result.standalone_query, state.to_dict(), completer, retries=0)
        self.assertIn("大學英文免修", result.standalone_query)
        self.assertNotIn("外語能力畢業門檻", result.standalone_query)
        self.assertEqual(scope.office_hint, "lc")

    def test_conversation_state_and_evidence_contract(self):
        from conversation_guardrail import ConversationResolution, ScopeDecision

        state = ConversationState(active_office="lc", active_topic="外語能力畢業門檻")
        updated = build_updated_state(
            state,
            conversation_id="c2",
            raw_query="要幾分",
            resolution=ConversationResolution.from_value(resolver_output()),
            scope=ScopeDecision("IN_SCOPE", "lc", 0.95, "ok"),
            selected_office="lc",
            source_ids=[12, "12", "source-b"],
            updated_at="2026-08-27T00:00:00+08:00",
        )
        self.assertEqual(updated.conversation_id, "c2")
        self.assertEqual(updated.previous_source_ids, ["12", "source-b"])
        self.assertTrue(updated.scope_verified)

        sufficient = check_evidence_sufficiency(
            "外語能力畢業門檻要幾分",
            [SimpleNamespace(
                page_content="外語能力畢業門檻需達到指定分數",
                metadata={"title": "語言中心規定"},
            )],
        )
        insufficient = check_evidence_sufficiency(
            "外語能力畢業門檻要幾分",
            [SimpleNamespace(
                page_content="校園交通與停車資訊",
                metadata={"title": "交通公告"},
            )],
        )
        self.assertTrue(sufficient.sufficient)
        self.assertFalse(insufficient.sufficient)

    def test_evidence_gate_rejects_competing_entity_even_with_topic_overlap(self):
        decision = check_evidence_sufficiency(
            "請問台灣大學的宿舍住宿管理規定是什麼",
            [SimpleNamespace(
                page_content="國立臺北大學住宿輔導與管理辦法：宿舍住宿管理規定",
                metadata={"title": "國立臺北大學住宿輔導與管理辦法"},
            )],
        )
        self.assertFalse(decision.sufficient)
        self.assertIn("台灣大學", decision.reason)


DORM_TOPIC = "國立臺北大學宿舍會客時間"
DORM_ANSWER = (
    "依目前查到的《國立臺北大學住宿輔導與管理辦法》相關內容，宿舍會客時間原則上為上午 9 時至下午 9 時。\n\n"
    "如果你要，我也可以幫你整理成**「可會客時間 / 禁止留宿時段 / 違規後果」**三點版。"
)
HR_TOPIC = "行政人員一年有多少天特休？"
HR_ANSWER = (
    "行政人員的「特休」不能一律用同一個天數回答，要先看您的任用身分與可採計年資。\n"
    "如果您要，我也可以直接幫您整理成「不同身分別的特休/休假日數」對照表。"
)
BLOCKED_ANSWER = (
    "目前沒有可安全回答這個問題的資料。我可以說明本系統的功能、使用方式與限制，"
    "也可以協助「體育室」（場地借用、課程、賽事）的相關問題喔！"
)


class RecordingCompleter(FakeCompleter):
    def __init__(self, outputs):
        super().__init__(outputs)
        self.prompts = []

    def __call__(self, messages, **kwargs):
        self.prompts.append(json.dumps(messages, ensure_ascii=False))
        return super().__call__(messages, **kwargs)


def verified_state(office, topic):
    return ConversationState(
        conversation_id="followup-ctx",
        active_office=office,
        active_topic=topic,
        scope_verified=True,
        previous_user_query=topic,
        previous_standalone_query=topic,
    )


def scope_context(state, raw_query, resolution):
    # Same shape as prepare_conversation_turn() in agentic_v2_5_4high.py.
    return {
        "active_office": state.active_office,
        "active_topic": state.active_topic,
        "scope_verified": state.scope_verified,
        "raw_query": raw_query,
        **resolution_scope_context(resolution),
    }


class ResolverTrustedFollowupTests(unittest.TestCase):
    """Screenshots 2026-09-24: "我要" and "我是教師 有8年了" were refused."""

    def test_accepting_assistant_offer_keeps_context(self):
        state = verified_state("osa", DORM_TOPIC)
        history = [
            {"role": "user", "content": "宿舍會客時間是幾點到幾點"},
            {"role": "assistant", "content": DORM_ANSWER},
        ]
        for query in ("我要", "好啊，麻煩你", "要，謝謝"):
            with self.subTest(query=query):
                completer = RecordingCompleter([
                    # The resolver misreads the bare reply as a new topic.
                    resolver_output(
                        is_followup=False,
                        topic_changed=True,
                        standalone_query=query,
                        inherited_office=None,
                        topic=query,
                        confidence=0.60,
                    ),
                    # The classifier is over-conservative about the short turn.
                    {"status": "OUT_OF_SCOPE", "office_hint": None, "confidence": 0.80, "reason": "只看到短句"},
                ])
                resolution = resolve_conversation(query, history, state, completer, retries=0)
                self.assertTrue(resolution.is_followup)
                self.assertFalse(resolution.topic_changed)
                self.assertEqual(resolution.followup_basis, "pattern")
                self.assertEqual(resolution.inherited_office, "osa")
                self.assertIn("禁止留宿時段", resolution.standalone_query)
                self.assertTrue(resolution.standalone_query.startswith(DORM_TOPIC))

                scope = run_scope_guardrail(
                    resolution.standalone_query,
                    scope_context(state, query, resolution),
                    completer,
                    retries=0,
                )
                self.assertEqual(scope.status, "IN_SCOPE")
                self.assertEqual(scope.office_hint, "osa")
                # The classifier must see the resolved question, not just "我要".
                self.assertIn("禁止留宿時段", completer.prompts[-1])

    def test_offer_acceptance_keeps_a_real_model_rewrite(self):
        state = verified_state("hr", HR_TOPIC)
        resolution = resolve_conversation(
            "我要",
            [{"role": "user", "content": HR_TOPIC}, {"role": "assistant", "content": HR_ANSWER}],
            state,
            FakeCompleter([resolver_output(
                is_followup=True,
                topic_changed=False,
                standalone_query="請整理不同任用身分別的特休與休假日數對照表",
                inherited_office="hr",
                topic=HR_TOPIC,
                confidence=0.88,
            )]),
            retries=0,
        )
        self.assertEqual(resolution.standalone_query, "請整理不同任用身分別的特休與休假日數對照表")
        self.assertEqual(resolution.followup_basis, "pattern")

    def test_offer_acceptance_survives_long_answers(self):
        state = verified_state("osa", DORM_TOPIC)
        long_answer = "條文內容。" * 400 + DORM_ANSWER
        resolution = resolve_conversation(
            "我要",
            [{"role": "assistant", "content": long_answer}],
            state,
            FakeCompleter([RuntimeError("resolver unavailable")]),
            retries=0,
        )
        self.assertTrue(resolution.is_followup)
        self.assertIn("禁止留宿時段", resolution.standalone_query)

    def test_affirmative_without_pending_offer_is_not_forced(self):
        state = verified_state("osa", DORM_TOPIC)
        resolution = resolve_conversation(
            "我要",
            [{"role": "assistant", "content": BLOCKED_ANSWER}],
            state,
            FakeCompleter([resolver_output(
                is_followup=False,
                topic_changed=True,
                standalone_query="我要",
                inherited_office=None,
                topic="我要",
                confidence=0.6,
            )]),
            retries=0,
        )
        self.assertFalse(resolution.is_followup)
        self.assertIsNone(resolution.followup_basis)

    def test_offer_acceptance_needs_verified_context(self):
        state = ConversationState(active_office="osa", active_topic=DORM_TOPIC, scope_verified=False)
        resolution = resolve_conversation(
            "我要",
            [{"role": "assistant", "content": DORM_ANSWER}],
            state,
            FakeCompleter([resolver_output(
                is_followup=False,
                topic_changed=True,
                standalone_query="我要",
                inherited_office=None,
                topic="我要",
                confidence=0.6,
            )]),
            retries=0,
        )
        self.assertFalse(resolution.is_followup)

    def test_combined_identity_and_seniority_reply(self):
        state = verified_state("hr", HR_TOPIC)
        for query in ("我是教師 有8年了", "我8年，是教師", "年資8年了", "我是專任教師"):
            with self.subTest(query=query):
                completer = FakeCompleter([
                    resolver_output(
                        is_followup=False,
                        topic_changed=True,
                        standalone_query=query,
                        inherited_office=None,
                        topic=query,
                        confidence=0.7,
                    ),
                    {"status": "OUT_OF_SCOPE", "office_hint": None, "confidence": 0.8, "reason": "只看到身分"},
                ])
                resolution = resolve_conversation(query, [], state, completer, retries=0)
                self.assertTrue(resolution.is_followup)
                self.assertEqual(resolution.inherited_office, "hr")
                self.assertEqual(resolution.standalone_query, f"{HR_TOPIC}：{query}")
                scope = run_scope_guardrail(
                    resolution.standalone_query,
                    scope_context(state, query, resolution),
                    completer,
                    retries=0,
                )
                self.assertEqual(scope.status, "IN_SCOPE")
                self.assertEqual(scope.office_hint, "hr")

    def test_model_judged_followup_is_classified_with_context(self):
        state = verified_state("hr", HR_TOPIC)
        query = "那兼任的算法一樣嗎"
        completer = RecordingCompleter([
            resolver_output(
                is_followup=True,
                topic_changed=False,
                standalone_query="兼任教師的特休天數算法是否與行政人員相同",
                inherited_office="hr",
                topic=HR_TOPIC,
                confidence=0.90,
            ),
            {"status": "IN_SCOPE", "office_hint": "hr", "confidence": 0.9, "reason": "人事休假追問"},
        ])
        resolution = resolve_conversation(query, [], state, completer, retries=0)
        self.assertEqual(resolution.followup_basis, "model")
        scope = run_scope_guardrail(
            resolution.standalone_query,
            scope_context(state, query, resolution),
            completer,
            retries=0,
        )
        self.assertEqual(scope.status, "IN_SCOPE")
        self.assertEqual(scope.office_hint, "hr")
        self.assertIn("兼任教師的特休天數", completer.prompts[-1])

    def test_model_judged_followup_rejected_by_classifier_is_not_promoted(self):
        state = verified_state("hr", HR_TOPIC)
        query = "那你喜歡看什麼電影"
        resolution = resolve_conversation(
            query,
            [],
            state,
            FakeCompleter([resolver_output(
                is_followup=True,
                topic_changed=False,
                standalone_query=f"{HR_TOPIC}：你喜歡看什麼電影",
                inherited_office="hr",
                topic=HR_TOPIC,
                confidence=0.85,
            )]),
            retries=0,
        )
        scope = run_scope_guardrail(
            resolution.standalone_query,
            scope_context(state, query, resolution),
            FakeCompleter([{"status": "OUT_OF_SCOPE", "office_hint": None, "confidence": 0.9, "reason": "閒聊"}]),
            retries=0,
        )
        # The standalone text still contains "特休", but inherited words are
        # not evidence once the classifier has seen the full context.
        self.assertEqual(scope.status, "OUT_OF_SCOPE")

    def test_low_confidence_model_followup_keeps_raw_classification(self):
        state = verified_state("hr", HR_TOPIC)
        query = "那你喜歡看什麼電影"
        resolution = ConversationResolution(
            is_followup=True,
            standalone_query=f"{HR_TOPIC}：{query}",
            inherited_office="hr",
            topic=HR_TOPIC,
            confidence=0.60,
            followup_basis="model",
        )
        completer = RecordingCompleter([
            {"status": "OUT_OF_SCOPE", "office_hint": None, "confidence": 0.9, "reason": "閒聊"},
        ])
        scope = run_scope_guardrail(
            resolution.standalone_query,
            scope_context(state, query, resolution),
            completer,
            retries=0,
        )
        self.assertEqual(scope.status, "OUT_OF_SCOPE")
        # Below the confidence bar the classifier sees only the raw turn.
        self.assertNotIn(HR_TOPIC, completer.prompts[-1])

    def test_model_followup_cannot_bypass_unrelated_intent_or_entity(self):
        state = verified_state("osa", DORM_TOPIC)
        for query, expected_reason in (("那附近的餐廳呢", "餐廳或美食推薦"), ("那台大的呢", "台大")):
            with self.subTest(query=query):
                resolution = ConversationResolution(
                    is_followup=True,
                    standalone_query=f"{DORM_TOPIC}：{query}",
                    inherited_office="osa",
                    topic=DORM_TOPIC,
                    confidence=0.95,
                    followup_basis="model",
                )

                def should_not_complete(*args, **kwargs):
                    raise AssertionError("deterministic boundary must run first")

                scope = run_scope_guardrail(
                    resolution.standalone_query,
                    scope_context(state, query, resolution),
                    should_not_complete,
                    retries=0,
                )
                self.assertEqual(scope.status, "OUT_OF_SCOPE")
                self.assertIn(expected_reason, scope.reason)

    def test_model_followup_classifier_failure_asks_for_clarification(self):
        state = verified_state("hr", HR_TOPIC)
        query = "那兼任的算法一樣嗎"
        resolution = ConversationResolution(
            is_followup=True,
            standalone_query="兼任教師的特休天數算法是否與行政人員相同",
            inherited_office="hr",
            topic=HR_TOPIC,
            confidence=0.9,
            followup_basis="model",
        )

        def failing(*args, **kwargs):
            raise RuntimeError("classifier unavailable")

        scope = run_scope_guardrail(
            resolution.standalone_query,
            scope_context(state, query, resolution),
            failing,
            retries=0,
        )
        self.assertEqual(scope.status, "AMBIGUOUS")


if __name__ == "__main__":
    unittest.main()
