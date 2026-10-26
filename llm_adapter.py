# -*- coding: utf-8 -*-
"""LLM 供應商切換層（openai / ollama）。

設定（config.txt 或環境變數）：
    LLM_PROVIDER=openai|ollama          預設 openai
    # openai 模式
    OPENAI_API_KEY=sk-...
    MODEL_BIG=gpt-6-luna                主模型：問題改寫、文字回答（老師 2026-10-12 指定）
    MODEL_SMALL=gpt-6-luna              其餘輔助任務（翻譯、HyDE、子主題擴充）；分類與評分走 CLASSIFIER_MODEL（Jev）
    # ollama 模式（實驗室電腦）
    OLLAMA_BASE_URL=http://localhost:11434
    OLLAMA_MODEL_BIG=gemma4:31b
    OLLAMA_MODEL_SMALL=gemma4:31b

對外介面：
    complete(messages, ...) -> str              輔助任務用（單次回覆文字）
    chat_events(messages, tools, ...) -> gen    agent loop 用：yield ("delta", 文字片段)…
                                                最後 yield ("final", {"content", "tool_calls"})
    MODEL_BIG / MODEL_SMALL / PROVIDER / SUPPORTS_STREAMING

注意：embedding、Whisper、TTS、圖片分析、評估評分員【不走】這層，
     它們固定使用 OpenAI（成本極低或作為固定量尺），詳見 GEMMA_MIGRATION.md。
"""

import json
import os
import re

from openai import OpenAI

# config.txt 可能尚未被主程式載入，這裡自行載一次（重複載入無害）。
# 注意：與 agentic 模組一致，config.txt 的值【覆蓋】既有環境變數——
# 否則 shell 裡殘留的過期 OPENAI_API_KEY 會依 import 順序偶發蓋掉正確的 key（實測踩過）。
_config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.txt")
if os.path.exists(_config_path):
    with open(_config_path, "r", encoding="utf-8") as _f:
        for _line in _f:
            if "=" in _line:
                _k, _v = _line.strip().split("=", 1)
                os.environ[_k.strip()] = _v.strip()

PROVIDER = os.getenv("LLM_PROVIDER", "openai").strip().lower()

if PROVIDER == "ollama":
    _base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
    client = OpenAI(base_url=_base + "/v1", api_key="ollama")  # Ollama 不驗 key，佔位即可
    MODEL_BIG = os.getenv("OLLAMA_MODEL_BIG", "gemma4:31b")
    MODEL_SMALL = os.getenv("OLLAMA_MODEL_SMALL", "gemma4:31b")
    SUPPORTS_STREAMING = False   # Ollama 串流 + tool_calls 相容性不穩，第一階段降級為整段回覆
    SUPPORTS_REASONING = False   # 開源模型無 reasoning_effort 參數
else:
    PROVIDER = "openai"
    _api_key = os.getenv("OPENAI_API_KEY", "").strip()
    _base_url = os.getenv(
        "OPENAI_BASE_URL", "https://api.openai.com/v1"
    ).rstrip("/")
    client = OpenAI(api_key=_api_key, base_url=_base_url)
    # 老師 2026-10-12 指定的模型分工：GPT-6 Luna（問題改寫、文字回答、圖片解析）＋ Jev 1.13（意圖分類、處室判斷、
    # 候選選擇、結果評分，見 CLASSIFIER_MODEL）＋ GPT Transcribe（語音轉文字）
    MODEL_BIG = os.getenv("MODEL_BIG", "gpt-6-luna")
    MODEL_SMALL = os.getenv("MODEL_SMALL", "gpt-6-luna")
    SUPPORTS_STREAMING = True
    SUPPORTS_REASONING = True

# 意圖與範圍分類（問題改寫、處室判斷）可改用另一個模型，透過 OpenRouter 呼叫，例如
# CLASSIFIER_MODEL=anthropic/claude-sonnet-5.5、OPENROUTER_API_KEY=...。沒設定時沿用 MODEL_SMALL。
CLASSIFIER_MODEL = os.getenv("CLASSIFIER_MODEL", "").strip()
_openrouter_key = os.getenv("OPENROUTER_API_KEY", "").strip()
classifier_client = (
    # 不自動重試：逾時或失敗就直接改用主模型（見 classify_complete）
    OpenAI(api_key=_openrouter_key, base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"), max_retries=0)
    if CLASSIFIER_MODEL and _openrouter_key else None
)

print(f"[LLM adapter] provider={PROVIDER}, big={MODEL_BIG}, small={MODEL_SMALL}, "
      f"classifier={CLASSIFIER_MODEL if classifier_client else MODEL_SMALL}")


# ── 每題的模型用量（2026-10-26 使用者要求：統計 token 與費用）──────────────────────────
# 一題問答會呼叫多次模型（改寫、範圍判斷、檢索、回答、證據檢查），平行的部分在 ThreadPoolExecutor 的執行緒裡：
# 用 contextvars 存這題的累計，並讓執行緒池沿用呼叫端的 context，平行呼叫也算得到。
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor as _TPE

_usage_var = contextvars.ContextVar("llm_usage", default=None)
_orig_submit = _TPE.submit


def _submit_with_context(self, fn, /, *args, **kwargs):
    return _orig_submit(self, contextvars.copy_context().run, fn, *args, **kwargs)


_TPE.submit = _submit_with_context  # pool.map 也走 submit

# 每百萬 token 的美元價格（輸入、輸出）；未設定時只記 token，不估費用。OpenRouter 的費用直接用回應裡的實際金額。
# 例：PRICE_GPT_6_LUNA="1.25,10"（模型名稱的 - 與 . 換成 _、全大寫）
def _price_of(model: str):
    raw = os.getenv("PRICE_" + re.sub(r"[^A-Za-z0-9]", "_", model or "").upper(), "").strip()
    try:
        inp, out = (float(x) for x in raw.split(","))
        return inp, out
    except ValueError:
        return None


def start_usage():
    """新的一題開始累計（每個請求開頭呼叫）。"""
    _usage_var.set({"lock": threading.Lock(), "by_model": {}})


def _record_usage(model, usage, provider):
    meter = _usage_var.get()
    if meter is None or usage is None:
        return
    p_in = int(getattr(usage, "prompt_tokens", 0) or 0)
    p_out = int(getattr(usage, "completion_tokens", 0) or 0)
    cost = getattr(usage, "cost", None)  # OpenRouter（usage.include）回傳實際金額
    if cost is None:
        price = _price_of(model)
        cost = (p_in * price[0] + p_out * price[1]) / 1_000_000 if price else None
    with meter["lock"]:
        m = meter["by_model"].setdefault(model or "?", {"provider": provider, "calls": 0, "input_tokens": 0,
                                                       "output_tokens": 0, "cost_usd": 0.0, "cost_known": True})
        m["calls"] += 1
        m["input_tokens"] += p_in
        m["output_tokens"] += p_out
        if cost is None:
            m["cost_known"] = False
        else:
            m["cost_usd"] += float(cost)


def usage_summary():
    """這題的模型用量：各模型的呼叫次數、token、費用（未知價格的模型 cost_known=false）。"""
    meter = _usage_var.get()
    if meter is None:
        return None
    with meter["lock"]:
        by_model = {k: dict(v, cost_usd=round(v["cost_usd"], 6)) for k, v in meter["by_model"].items()}
    known = [v for v in by_model.values() if v["cost_known"]]
    return {
        "calls": sum(v["calls"] for v in by_model.values()),
        "input_tokens": sum(v["input_tokens"] for v in by_model.values()),
        "output_tokens": sum(v["output_tokens"] for v in by_model.values()),
        "cost_usd": round(sum(v["cost_usd"] for v in known), 6),
        "cost_complete": len(known) == len(by_model),
        "by_model": by_model,
    }


def _build_kwargs(messages, model, tools, tool_choice, temperature,
                  max_tokens, reasoning_effort, stream, response_format=None):
    kwargs = {"model": model or MODEL_BIG, "messages": messages}
    if tools:
        kwargs["tools"] = tools
        if tool_choice:
            kwargs["tool_choice"] = tool_choice
    if stream:
        kwargs["stream"] = True
        kwargs["stream_options"] = {"include_usage": True}  # 最後一個 chunk 附 token 用量
    if response_format:
        kwargs["response_format"] = response_format
    if max_tokens:
        # openai 新模型要求 max_completion_tokens；ollama 走 max_tokens
        if PROVIDER == "openai":
            kwargs["max_completion_tokens"] = max_tokens
        else:
            kwargs["max_tokens"] = max_tokens
    if reasoning_effort and SUPPORTS_REASONING:
        kwargs["reasoning_effort"] = reasoning_effort
        # reasoning 模型不接受自訂 temperature
    elif temperature is not None:
        kwargs["temperature"] = temperature
    return kwargs


def _create_retry(kwargs):
    """第二次呼叫；仍有不支援的參數（例如 temperature）就再剝除一次。"""
    try:
        return client.chat.completions.create(**kwargs)
    except Exception as e:
        msg = str(e)
        dropped = [k for k in ("temperature", "response_format", "tool_choice") if k in msg and kwargs.pop(k, None) is not None]
        if dropped:
            return client.chat.completions.create(**kwargs)
        raise


def _create(messages, model=None, tools=None, tool_choice=None, temperature=None,
            max_tokens=None, reasoning_effort=None, stream=False,
            response_format=None):
    rsp = _create_raw(messages, model, tools, tool_choice, temperature, max_tokens, reasoning_effort, stream,
                      response_format)
    if not stream:
        _record_usage(model or MODEL_BIG, getattr(rsp, "usage", None), "openai")
    return rsp


def _create_raw(messages, model=None, tools=None, tool_choice=None, temperature=None,
                max_tokens=None, reasoning_effort=None, stream=False,
                response_format=None):
    kwargs = _build_kwargs(messages, model, tools, tool_choice, temperature,
                           max_tokens, reasoning_effort, stream, response_format)
    try:
        return client.chat.completions.create(**kwargs)
    except Exception as e:
        # 供應商不認得的參數（如 reasoning_effort / max_completion_tokens）自動剝除重試
        msg = str(e)
        retried = False
        # GPT-6 Luna 在 chat completions 帶工具時只接受 reasoning_effort='none'（2026-10-12 錯誤訊息明示）
        if "reasoning_effort" in msg and "'none'" in msg and kwargs.get("reasoning_effort") != "none":
            kwargs["reasoning_effort"] = "none"
            kwargs.pop("temperature", None)
            return _create_retry(kwargs)
        # GPT-6 系列只接受預設 temperature（2026-10-12：temperature=0 會回 400）
        for bad in ("reasoning_effort", "max_completion_tokens", "tool_choice", "response_format", "temperature",
                    "stream_options"):
            if bad in msg and bad in kwargs:
                val = kwargs.pop(bad)
                if bad == "max_completion_tokens":
                    kwargs["max_tokens"] = val
                retried = True
        if retried:
            return client.chat.completions.create(**kwargs)
        raise


# 輔助任務（問題改寫、HyDE、翻譯、子主題擴充）不需要長推理。GPT-6 Luna 的推理 token 會算進輸出上限，
# max_tokens=150 時推理就用完、回傳空白（2026-10-12：子主題擴充每次都失敗）。設為 none 也比較快。
AUX_REASONING_EFFORT = os.getenv("AUX_REASONING_EFFORT", "none").strip()


def complete(messages, model=None, temperature=0, max_tokens=None,
             response_format=None, reasoning_effort=None) -> str:
    """輔助任務用：單次呼叫回覆文字（分類、改寫、rerank、摘要等）"""
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    rsp = _create(messages, model=model or MODEL_SMALL,
                  temperature=temperature, max_tokens=max_tokens,
                  response_format=response_format,
                  reasoning_effort=reasoning_effort or AUX_REASONING_EFFORT or None)
    return (rsp.choices[0].message.content or "").strip()


# Jev 經 OpenRouter 呼叫，回應時間不穩（2026-10-12 實測範圍判斷平均 8.7 秒、最慢 66 秒）：
# 超過這個秒數就放棄、改用主模型，不讓單次分類拖慢整個問答。
CLASSIFIER_TIMEOUT_SECONDS = float(os.getenv("CLASSIFIER_TIMEOUT_SECONDS", "8"))


def classify_complete(messages, temperature=0, max_tokens=None, response_format=None, **_ignored) -> str:
    """意圖與範圍分類用。設定了 CLASSIFIER_MODEL 與 OPENROUTER_API_KEY 時改用該模型；
    呼叫失敗（網路、額度、模型不支援某參數）就退回 MODEL_SMALL，不讓分類中斷整個問答。"""
    if classifier_client is None:
        return complete(messages, temperature=temperature, max_tokens=max_tokens, response_format=response_format)
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    # usage.include：OpenRouter 在回應裡附上這次呼叫的實際費用
    kwargs = {"model": CLASSIFIER_MODEL, "messages": messages, "temperature": temperature,
              "extra_body": {"usage": {"include": True}}}
    if max_tokens:
        kwargs["max_tokens"] = max_tokens
    if response_format:
        kwargs["response_format"] = response_format
    try:
        try:
            rsp = classifier_client.chat.completions.create(**kwargs, timeout=CLASSIFIER_TIMEOUT_SECONDS)
        except Exception as e:
            if "response_format" not in str(e) or "response_format" not in kwargs:
                raise
            kwargs.pop("response_format")
            rsp = classifier_client.chat.completions.create(**kwargs, timeout=CLASSIFIER_TIMEOUT_SECONDS)
        _record_usage(CLASSIFIER_MODEL, getattr(rsp, "usage", None), "openrouter")
        text = (rsp.choices[0].message.content or "").strip()
        if text:
            return text
        raise ValueError("empty classifier response")
    except Exception as e:
        print(f"[LLM adapter] classifier {CLASSIFIER_MODEL} failed, falling back to {MODEL_SMALL}: {type(e).__name__}")
        return complete(messages, temperature=temperature, max_tokens=max_tokens, response_format=response_format)


def _msg_to_dict(m) -> dict:
    """Chat Completions 回覆 → 統一格式 {content, tool_calls:[{id,name,arguments}]}"""
    calls = []
    for tc in (m.tool_calls or []):
        calls.append({"id": tc.id, "name": tc.function.name,
                      "arguments": tc.function.arguments or "{}"})
    return {"content": m.content or "", "tool_calls": calls}


def chat_events(messages, model=None, tools=None, tool_choice=None,
                reasoning_effort=None):
    """agent loop 用的統一事件流。

    yield ("delta", 文字片段)   逐字內容（僅在供應商支援串流時）
    yield ("final", {"content": str, "tool_calls": [{"id","name","arguments"}]})
    """
    model = model or MODEL_BIG

    if not SUPPORTS_STREAMING:
        rsp = _create(messages, model=model, tools=tools, tool_choice=tool_choice,
                      reasoning_effort=reasoning_effort)
        yield ("final", _msg_to_dict(rsp.choices[0].message))
        return

    stream = _create(messages, model=model, tools=tools, tool_choice=tool_choice,
                     reasoning_effort=reasoning_effort, stream=True)
    content_parts = []
    calls = {}  # index -> {id, name, arguments 累積}
    for chunk in stream:
        if getattr(chunk, "usage", None):
            _record_usage(model, chunk.usage, "openai")  # stream_options.include_usage：最後一個 chunk
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta is None:
            continue
        if delta.content:
            content_parts.append(delta.content)
            yield ("delta", delta.content)
        for tc in (delta.tool_calls or []):
            slot = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
            if tc.id:
                slot["id"] = tc.id
            if tc.function:
                if tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function.arguments:
                    slot["arguments"] += tc.function.arguments
    tool_calls = [calls[i] for i in sorted(calls)]
    yield ("final", {"content": "".join(content_parts), "tool_calls": tool_calls})
