import json
import unittest
from types import SimpleNamespace

from conversation_guardrail import (
    ConversationState,
    build_updated_state,
    check_evidence_sufficiency,
    detect_explicit_unsupported_intent,
    detect_service_entity_conflict,
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


if __name__ == "__main__":
    unittest.main()
