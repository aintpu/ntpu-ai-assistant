import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

import llm_adapter  # noqa: E402


def _rsp(text):
    r = MagicMock()
    r.choices = [MagicMock(message=MagicMock(content=text))]
    return r


class ClassifierModelTests(unittest.TestCase):
    """意圖與範圍分類可改用 OpenRouter 上的模型（例如 Sonnet 5.5），失敗時退回 MODEL_SMALL。"""

    def test_without_classifier_uses_the_small_model(self):
        with patch.object(llm_adapter, "classifier_client", None), \
                patch.object(llm_adapter, "complete", return_value="small") as small:
            self.assertEqual(llm_adapter.classify_complete([{"role": "user", "content": "x"}]), "small")
        small.assert_called_once()

    def test_uses_the_configured_classifier_model(self):
        client = MagicMock()
        client.chat.completions.create.return_value = _rsp('{"status":"IN_SCOPE"}')
        with patch.object(llm_adapter, "classifier_client", client), \
                patch.object(llm_adapter, "CLASSIFIER_MODEL", "anthropic/claude-sonnet-5.5"), \
                patch.object(llm_adapter, "complete") as small:
            out = llm_adapter.classify_complete("q", response_format={"type": "json_object"}, max_tokens=200)
        self.assertEqual(out, '{"status":"IN_SCOPE"}')
        kwargs = client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "anthropic/claude-sonnet-5.5")
        self.assertEqual(kwargs["response_format"], {"type": "json_object"})
        small.assert_not_called()

    def test_falls_back_when_the_classifier_fails_or_returns_nothing(self):
        for side_effect in (RuntimeError("402 insufficient credits"), [_rsp("")]):
            client = MagicMock()
            client.chat.completions.create.side_effect = side_effect
            with patch.object(llm_adapter, "classifier_client", client), \
                    patch.object(llm_adapter, "complete", return_value="small") as small:
                self.assertEqual(llm_adapter.classify_complete("q"), "small")
            small.assert_called_once()

    def test_retries_without_response_format_when_unsupported(self):
        client = MagicMock()
        client.chat.completions.create.side_effect = [RuntimeError("response_format not supported"), _rsp("ok")]
        with patch.object(llm_adapter, "classifier_client", client):
            self.assertEqual(llm_adapter.classify_complete("q", response_format={"type": "json_object"}), "ok")
        self.assertNotIn("response_format", client.chat.completions.create.call_args.kwargs)

    def test_scope_and_resolver_use_the_classifier(self):
        import pathlib
        src = (pathlib.Path(__file__).resolve().parents[1] / "agentic_v2_5_4high.py").read_text(encoding="utf-8")
        self.assertNotIn("complete_fn=llm_adapter.complete", src)
        # 改寫、範圍判斷、處室分類，加上回答後檢查證據與修正後再檢查（老師建議 二-2）
        self.assertEqual(src.count("llm_adapter.classify_complete"), 5)


if __name__ == "__main__":
    unittest.main()
