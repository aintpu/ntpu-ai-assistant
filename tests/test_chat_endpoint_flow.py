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
    def test_system_question_bypasses_six_office_rag(self):
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


if __name__ == "__main__":
    unittest.main()
