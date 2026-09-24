import base64
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-only-key")
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

try:
    from fastapi.testclient import TestClient
    import agentic_v2_5_4high as core
    from conversation_guardrail import ConversationResolution, ConversationState, ScopeDecision
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    TestClient = None
    core = None
    _IMPORT_ERROR = str(exc)

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 64


def ok_decision(question="宿舍會客時間是幾點"):
    state = ConversationState(conversation_id="voice-1", active_office="osa", active_topic=question, scope_verified=True)
    return {
        "status": "ok",
        "state": state,
        "resolution": ConversationResolution(standalone_query=question, topic=question, confidence=0.9),
        "scope": ScopeDecision("IN_SCOPE", "osa", 0.9, "test"),
        "office": "osa",
        "domain": "OSA",
    }


@unittest.skipIf(_IMPORT_ERROR, f"backend dependencies unavailable: {_IMPORT_ERROR}")
class VoicePipelineTests(unittest.TestCase):
    def setUp(self):
        # TestClient 的請求都來自同一個位址，避免被其他測試累積的限流擋下。
        patcher = patch.object(core, "_is_rate_limited", return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_audio_format_is_sniffed_from_bytes(self):
        cases = {
            WEBM: "webm",
            MP4: "mp4",  # Safari MediaRecorder
            b"OggS" + b"\x00" * 8: "ogg",
            b"RIFF\x00\x00\x00\x00WAVE": "wav",
            b"ID3\x03" + b"\x00" * 8: "mp3",
            b"\xff\xfb\x90\x00": "mp3",
            b"unknown": "webm",
        }
        for raw, ext in cases.items():
            with self.subTest(ext=ext):
                self.assertEqual(core._sniff_audio_format(raw)[0], ext)

    def test_transcription_uses_real_extension_and_traditional_chinese_prompt(self):
        calls = []

        def create(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(text="宿舍會客時間是幾點")

        with patch.object(core.audio_client.audio.transcriptions, "create", side_effect=create):
            text = core.transcribe_audio_bytes(MP4)
        self.assertEqual(text, "宿舍會客時間是幾點")
        self.assertEqual(calls[0]["model"], core.STT_MODEL)
        self.assertEqual(calls[0]["file"][0], "voice.mp4")
        self.assertEqual(calls[0]["file"][2], "audio/mp4")
        self.assertIn("繁體中文", calls[0]["prompt"])

    def test_transcription_falls_back_then_reports_failure_as_empty(self):
        models = []

        def create(**kwargs):
            models.append(kwargs["model"])
            if kwargs["model"] == core.STT_MODEL:
                raise RuntimeError("model_not_found")
            return SimpleNamespace(text="選課時間")

        with patch.object(core.audio_client.audio.transcriptions, "create", side_effect=create):
            self.assertEqual(core.transcribe_audio_bytes(WEBM), "選課時間")
        self.assertEqual(models, [core.STT_MODEL, *core.STT_FALLBACK_MODELS][:2])

        with patch.object(core.audio_client.audio.transcriptions, "create", side_effect=RuntimeError("down")):
            self.assertEqual(core.transcribe_audio_bytes(WEBM), "")
        self.assertEqual(core.transcribe_audio_bytes(b""), "")

    def test_prompt_echo_is_treated_as_silence_but_short_real_words_are_kept(self):
        with patch.object(core.audio_client.audio.transcriptions, "create",
                          return_value=SimpleNamespace(text=core.STT_PROMPT)):
            self.assertEqual(core.transcribe_audio_bytes(WEBM), "")
        with patch.object(core.audio_client.audio.transcriptions, "create",
                          return_value=SimpleNamespace(text="宿舍")):
            self.assertEqual(core.transcribe_audio_bytes(WEBM), "宿舍")

    def test_speech_is_returned_as_base64_mp3(self):
        calls = []

        def create(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(content=b"ID3fake-mp3")

        with patch.object(core.audio_client.audio.speech, "create", side_effect=create):
            b64 = core.synthesize_speech("**會客時間**為上午 9 時至下午 9 時。", "zh-TW")
        self.assertEqual(base64.b64decode(b64), b"ID3fake-mp3")
        self.assertEqual(calls[0]["model"], core.TTS_MODEL)
        self.assertNotIn("*", calls[0]["input"])
        self.assertIn("instructions", calls[0]["extra_body"])
        self.assertNotIn("speed", calls[0])

    def test_speech_falls_back_to_legacy_model_and_returns_none_on_failure(self):
        models = []

        def create(**kwargs):
            models.append(kwargs["model"])
            if kwargs["model"] == core.TTS_MODEL:
                raise RuntimeError("model_not_found")
            self.assertIn("speed", kwargs)
            self.assertNotIn("extra_body", kwargs)
            return SimpleNamespace(content=b"mp3")

        with patch.object(core.audio_client.audio.speech, "create", side_effect=create):
            self.assertIsNotNone(core.synthesize_speech("你好", "zh-TW"))
        self.assertEqual(models[:2], [core.TTS_MODEL, core.TTS_FALLBACK_MODELS[0]])

        with patch.object(core.audio_client.audio.speech, "create", side_effect=RuntimeError("down")):
            self.assertIsNone(core.synthesize_speech("你好", "zh-TW"))

    def test_voice_endpoint_returns_transcript_answer_and_playable_audio(self):
        client = TestClient(core.app)
        audio = base64.b64encode(MP4).decode()
        with patch.object(core.audio_client.audio.transcriptions, "create",
                          return_value=SimpleNamespace(text="宿舍會客時間是幾點")), \
                patch.object(core, "prepare_conversation_turn", return_value=ok_decision()), \
                patch.object(core, "synthesize_agentic_answer", return_value="會客時間為上午 9 時至下午 9 時。"), \
                patch.object(core, "summarize_for_speech", return_value="會客時間是早上九點到晚上九點。"), \
                patch.object(core.audio_client.audio.speech, "create",
                             return_value=SimpleNamespace(content=b"ID3mp3")):
            resp = client.post("/api/voice", json={"audio_base64": audio, "history": []}).json()
        self.assertEqual(resp["status"], "ok")
        self.assertEqual(resp["question"], "宿舍會客時間是幾點")
        self.assertEqual(base64.b64decode(resp["audio_base64"]), b"ID3mp3")

    def test_failed_transcription_asks_user_to_retry_instead_of_answering(self):
        client = TestClient(core.app)
        with patch.object(core.audio_client.audio.transcriptions, "create", side_effect=RuntimeError("down")), \
                patch.object(core, "prepare_conversation_turn") as prepare:
            resp = client.post("/api/voice", json={"audio_base64": base64.b64encode(WEBM).decode()}).json()
        prepare.assert_not_called()
        self.assertEqual(resp["status"], "error")
        self.assertIn("沒有聽清楚", resp["message"])

    def test_oversized_audio_is_rejected_before_transcription(self):
        client = TestClient(core.app)
        with patch.object(core, "MAX_AUDIO_BYTES", 10), \
                patch.object(core.audio_client.audio.transcriptions, "create") as create:
            resp = client.post("/api/voice", json={"audio_base64": base64.b64encode(WEBM).decode()}).json()
        create.assert_not_called()
        self.assertEqual(resp["status"], "error")


if __name__ == "__main__":
    unittest.main()
