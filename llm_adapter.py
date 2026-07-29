# -*- coding: utf-8 -*-
"""LLM 供應商切換層（openai / ollama）。

設定（config.txt 或環境變數）：
    LLM_PROVIDER=openai|ollama          預設 openai
    # openai 模式
    OPENAI_API_KEY=sk-...
    MODEL_BIG=gpt-5.4-mini              agent 主模型
    MODEL_SMALL=gpt-4o-mini             分類/改寫/rerank 等輔助任務
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
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))
    MODEL_BIG = os.getenv("MODEL_BIG", "gpt-5.4-mini")
    MODEL_SMALL = os.getenv("MODEL_SMALL", "gpt-4o-mini")
    SUPPORTS_STREAMING = True
    SUPPORTS_REASONING = True

print(f"[LLM adapter] provider={PROVIDER}, big={MODEL_BIG}, small={MODEL_SMALL}")


def _build_kwargs(messages, model, tools, tool_choice, temperature,
                  max_tokens, reasoning_effort, stream):
    kwargs = {"model": model or MODEL_BIG, "messages": messages}
    if tools:
        kwargs["tools"] = tools
        if tool_choice:
            kwargs["tool_choice"] = tool_choice
    if stream:
        kwargs["stream"] = True
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


def _create(messages, model=None, tools=None, tool_choice=None, temperature=None,
            max_tokens=None, reasoning_effort=None, stream=False):
    kwargs = _build_kwargs(messages, model, tools, tool_choice, temperature,
                           max_tokens, reasoning_effort, stream)
    try:
        return client.chat.completions.create(**kwargs)
    except Exception as e:
        # 供應商不認得的參數（如 reasoning_effort / max_completion_tokens）自動剝除重試
        msg = str(e)
        retried = False
        for bad in ("reasoning_effort", "max_completion_tokens", "tool_choice"):
            if bad in msg and bad in kwargs:
                val = kwargs.pop(bad)
                if bad == "max_completion_tokens":
                    kwargs["max_tokens"] = val
                retried = True
        if retried:
            return client.chat.completions.create(**kwargs)
        raise


def complete(messages, model=None, temperature=0, max_tokens=None) -> str:
    """輔助任務用：單次呼叫回覆文字（分類、改寫、rerank、摘要等）"""
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    rsp = _create(messages, model=model or MODEL_SMALL,
                  temperature=temperature, max_tokens=max_tokens)
    return (rsp.choices[0].message.content or "").strip()


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
