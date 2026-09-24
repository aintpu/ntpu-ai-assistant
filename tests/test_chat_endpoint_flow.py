import json
import os
import unittest
from unittest.mock import patch


# The production module builds FAISS at import time. Keep this contract test
# deterministic and network-free; the endpoint and resolver still run for real.
os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    from fastapi.testclient import TestClient
    import agentic_v2_5_4high as core
    from conversation_guardrail import ConversationState, build_updated_state
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    TestClient = None
    core = None
    ConversationState = None
    build_updated_state = None
    _IMPORT_ERROR = str(exc)


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class ChatEndpointFlowTests(unittest.TestCase):
    def test_system_question_bypasses_seven_office_rag(self):
        def fake_complete(messages, **kwargs):
            system = messages[0]["content"]
            if "Conversation Context Resolver" in system:
                return json.dumps({
                    "is_followup": False,
                    "topic_changed": False,
                    "standalone_query": "你可以回答哪些問題？",
                    "inherited_office": None,
                    "topic": "系統服務範圍",
                    "ambiguity": False,
                    "ambiguity_reason": None,
                    "confidence": 0.98,
                }, ensure_ascii=False)
            raise AssertionError("SYSTEM question must not call scope or RAG")

        client = TestClient(core.app)
        with patch.object(core, "_is_prompt_injection", return_value=False), \
                patch.object(core.llm_adapter, "complete", side_effect=fake_complete), \
                patch.object(core, "synthesize_agentic_answer") as synthesize:
            response = client.post("/api/chat", json={
                "question": "你可以回答哪些問題？",
                "conversation_id": "integration-system-1",
                "history": [],
                "conversation_state": {},
            })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["domain"], "SYSTEM")
        self.assertEqual(payload["sources"][0]["type"], "system")
        self.assertEqual(payload["sources"][0]["faq_id"], "system-capabilities")
        self.assertEqual(payload["conversation_state"]["active_topic"], "SYSTEM:system-capabilities")
        synthesize.assert_not_called()

    def test_other_route_can_fall_back_to_system_faq(self):
        def fake_complete(messages, **kwargs):
            system = messages[0]["content"]
            if "Conversation Context Resolver" in system:
                return json.dumps({
                    "is_followup": False,
                    "topic_changed": False,
                    "standalone_query": "資料從哪來",
                    "inherited_office": None,
                    "topic": "資料來源",
                    "ambiguity": False,
                    "ambiguity_reason": None,
                    "confidence": 0.82,
                }, ensure_ascii=False)
            if "Business Scope Guardrail" in system:
                return json.dumps({
                    "status": "OUT_OF_SCOPE",
                    "office_hint": None,
                    "confidence": 0.91,
                    "reason": "未指明校務處室",
                }, ensure_ascii=False)
            raise AssertionError(f"unexpected completion prompt: {system[:80]}")

        client = TestClient(core.app)
        with patch.object(core, "_is_prompt_injection", return_value=False), \
                patch.object(core.llm_adapter, "complete", side_effect=fake_complete), \
                patch.object(core, "synthesize_agentic_answer") as synthesize:
            response = client.post("/api/chat", json={
                "question": "資料從哪來",
                "conversation_id": "integration-system-fallback-1",
                "history": [],
                "conversation_state": {},
            })

        payload = response.json()
        self.assertEqual(payload["domain"], "SYSTEM")
        self.assertEqual(payload["sources"][0]["faq_id"], "system-sources")
        synthesize.assert_not_called()

    def test_foreign_language_requirement_followup_stays_in_scope(self):
        calls = []

        def fake_complete(messages, **kwargs):
            system = messages[0]["content"]
            user = messages[-1]["content"]
            if "Conversation Context Resolver" in system:
                if "要幾分" in user:
                    result = {
                        "is_followup": True,
                        "topic_changed": False,
                        "standalone_query": "外語能力畢業門檻：要幾分",
                        "inherited_office": "lc",
                        "topic": "外語能力畢業門檻",
                        "ambiguity": False,
                        "ambiguity_reason": None,
                        "confidence": 0.95,
                    }
                else:
                    result = {
                        "is_followup": False,
                        "topic_changed": False,
                        "standalone_query": "外語能力畢業門檻",
                        "inherited_office": None,
                        "topic": "外語能力畢業門檻",
                        "ambiguity": False,
                        "ambiguity_reason": None,
                        "confidence": 0.95,
                    }
                return json.dumps(result, ensure_ascii=False)
            if "Business Scope Guardrail" in system:
                return json.dumps({
                    "status": "IN_SCOPE",
                    "office_hint": "lc",
                    "confidence": 0.95,
                    "reason": "語言中心主題",
                }, ensure_ascii=False)
            raise AssertionError(f"unexpected completion prompt: {system[:80]}")

        def fake_synthesize(user_query, language, history, **kwargs):
            calls.append({"query": user_query, **kwargs})
            state = ConversationState.from_value(kwargs["conversation_state"])
            updated = build_updated_state(
                state,
                conversation_id=kwargs["session_id"],
                raw_query=user_query,
                resolution=kwargs["resolution"],
                scope=kwargs["scope"],
                selected_office=kwargs["selected_office"],
                source_ids=[],
                updated_at="2026-08-27T00:00:00+08:00",
            )
            core._set_last_conversation_state(updated)
            return "mocked in-scope answer"

        client = TestClient(core.app)
        conversation_id = "integration-language-1"
        history = [
            {"role": "user", "content": "外語能力畢業門檻"},
            {"role": "assistant", "content": "mocked in-scope answer"},
        ]

        with patch.object(core, "_is_prompt_injection", return_value=False), \
                patch.object(core.llm_adapter, "complete", side_effect=fake_complete), \
                patch.object(core, "synthesize_agentic_answer", side_effect=fake_synthesize):
            first = client.post("/api/chat", json={
                "question": "外語能力畢業門檻",
                "conversation_id": conversation_id,
                "history": [],
                "conversation_state": {},
            })
            self.assertEqual(first.status_code, 200)
            first_json = first.json()
            self.assertEqual(first_json["status"], "ok")

            second = client.post("/api/chat", json={
                "question": "要幾分",
                "conversation_id": conversation_id,
                "history": history,
                "conversation_state": first_json["conversation_state"],
            })

        self.assertEqual(second.status_code, 200)
        second_json = second.json()
        self.assertEqual(second_json["status"], "ok")
        self.assertNotIn("不在服務範圍內", second_json["answer"])
        self.assertEqual(second_json["scope_status"], "IN_SCOPE")
        self.assertEqual(calls[-1]["dept"], "lc")
        self.assertTrue(calls[-1]["resolution"].is_followup)
        self.assertEqual(
            calls[-1]["resolution"].standalone_query,
            "外語能力畢業門檻：要幾分",
        )


    def test_offer_acceptance_and_combined_reply_reach_rag(self):
        """2026-09-24 screenshots: "我要" / "我是教師 有8年了" were refused."""
        cases = (
            (
                "宿舍會客時間是幾點", "osa", "宿舍",
                "會客時間為 9 時至 21 時。\n如果你要，我也可以幫你整理成「可會客時間 / 禁止留宿時段 / 違規後果」三點版。",
                "我要", "禁止留宿時段",
            ),
            (
                "行政人員特休有幾天", "hr", "特休",
                "要先看任用身分與可採計年資。\n如果您要，我也可以直接幫您整理成「不同身分別的特休/休假日數」對照表。",
                "我是教師 有8年了", "我是教師 有8年了",
            ),
        )
        for first_q, office, keyword, answer, second_q, expected_in_query in cases:
            with self.subTest(second_q=second_q):
                calls = []

                def fake_complete(messages, **kwargs):
                    system = messages[0]["content"]
                    user = messages[-1]["content"]
                    if "Conversation Context Resolver" in system:
                        current = user.split("\\n", 1)[0]
                        # Worst case: the resolver treats the short reply as a new topic.
                        return json.dumps({
                            "is_followup": False,
                            "topic_changed": second_q in current,
                            "standalone_query": current.replace("目前問題：", ""),
                            "inherited_office": None,
                            "topic": current.replace("目前問題：", ""),
                            "ambiguity": False,
                            "ambiguity_reason": None,
                            "confidence": 0.6,
                        }, ensure_ascii=False)
                    if "Business Scope Guardrail" in system:
                        in_scope = keyword in user.split("context：", 1)[0]
                        return json.dumps({
                            "status": "IN_SCOPE" if in_scope else "OUT_OF_SCOPE",
                            "office_hint": office if in_scope else None,
                            "confidence": 0.9,
                            "reason": "test",
                        }, ensure_ascii=False)
                    raise AssertionError(f"unexpected completion prompt: {system[:80]}")

                def fake_synthesize(user_query, language, history, **kwargs):
                    calls.append({"query": user_query, **kwargs})
                    state = ConversationState.from_value(kwargs["conversation_state"])
                    core._set_last_conversation_state(build_updated_state(
                        state,
                        conversation_id=kwargs["session_id"],
                        raw_query=user_query,
                        resolution=kwargs["resolution"],
                        scope=kwargs["scope"],
                        selected_office=kwargs["selected_office"],
                        source_ids=["doc-1"],
                        updated_at="2026-09-24T00:00:00+08:00",
                    ))
                    return "mocked in-scope answer"

                client = TestClient(core.app)
                with patch.object(core, "_is_prompt_injection", return_value=False), \
                        patch.object(core.llm_adapter, "complete", side_effect=fake_complete), \
                        patch.object(core, "synthesize_agentic_answer", side_effect=fake_synthesize):
                    first = client.post("/api/chat", json={
                        "question": first_q,
                        "conversation_id": f"followup-{office}",
                        "history": [],
                        "conversation_state": {},
                    }).json()
                    self.assertEqual(first["status"], "ok")
                    second = client.post("/api/chat", json={
                        "question": second_q,
                        "conversation_id": f"followup-{office}",
                        "history": [
                            {"role": "user", "content": first_q},
                            {"role": "assistant", "content": answer},
                        ],
                        "conversation_state": first["conversation_state"],
                    }).json()

                self.assertEqual(second["status"], "ok")
                self.assertEqual(second["scope_status"], "IN_SCOPE")
                self.assertEqual(calls[-1]["dept"], office)
                self.assertTrue(calls[-1]["resolution"].is_followup)
                self.assertIn(expected_in_query, calls[-1]["resolution"].standalone_query)

if __name__ == "__main__":
    unittest.main()
