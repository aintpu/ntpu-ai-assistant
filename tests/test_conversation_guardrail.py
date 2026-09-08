import json
import unittest
from types import SimpleNamespace

from conversation_guardrail import (
    ConversationState,
    build_updated_state,
    check_evidence_sufficiency,
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


if __name__ == "__main__":
    unittest.main()
