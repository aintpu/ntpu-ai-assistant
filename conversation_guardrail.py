"""Conversation-aware guardrails for the NTPU AI Assistant.

This module deliberately has no FastAPI, LangChain, or provider imports so the
conversation contract can be unit-tested without building the FAISS index.
The backend supplies ``llm_adapter.complete`` as the JSON completion function.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterable


VALID_OFFICES = {"ope", "ge", "lc", "oaa", "osa", "hr"}
OFFICE_NAMES = {
    "ope": "體育室",
    "ge": "通識教育中心",
    "lc": "語言中心",
    "oaa": "教務處",
    "osa": "學務處",
    "hr": "人事室",
}

OFFICE_KEYWORDS = {
    "ope": (
        "體育", "運動", "場地", "體育館", "崇越館", "課表", "賽事", "競賽",
        "全大運", "系際盃", "器材", "運動獎學金",
    ),
    "ge": (
        "通識", "向度", "通識學分", "通識月", "夏季學院", "跨校通識",
    ),
    "lc": (
        "語言中心", "外語", "大學英文", "免修", "抵免", "托福", "toefl",
        "多益", "toeic", "雅思", "ielts", "英檢", "語言能力",
    ),
    "oaa": (
        "教務", "學籍", "註冊", "休學", "復學", "退學", "轉系", "雙主修",
        "輔系", "選課", "成績", "畢業資格", "學位", "學分費", "成績單",
    ),
    "osa": (
        "學務", "住宿", "宿舍", "獎助學金", "助學金", "就學貸款", "學生請假",
        "社團", "兵役", "心理諮商", "健康中心", "學生保險",
    ),
    "hr": (
        "人事", "差勤", "刷卡", "請假", "事假", "病假", "身心調適假", "婚假",
        "產假", "陪產假", "喪假", "勞基法", "變形工時",
    ),
}

CHAT_PHRASES = {
    "你好", "嗨", "哈囉", "hello", "hi", "謝謝", "謝謝你", "感謝", "好的",
    "好", "了解", "收到", "沒問題", "你是誰", "你能做什麼",
}
FOLLOWUP_MARKERS = (
    "那", "這個", "這樣", "它", "這些", "呢", "嗎", "可以嗎", "要幾分",
    "多久", "怎麼申請", "要去哪裡", "還有其他", "什麼時候", "需要什麼",
)


@dataclass
class ConversationState:
    conversation_id: str = ""
    active_office: str | None = None
    active_topic: str | None = None
    scope_verified: bool = False
    previous_user_query: str | None = None
    previous_standalone_query: str | None = None
    previous_source_ids: list[str] = field(default_factory=list)
    conversation_summary: str | None = None
    last_updated_at: str = ""

    @classmethod
    def from_value(cls, value: Any, conversation_id: str = "") -> "ConversationState":
        if isinstance(value, cls):
            state = value
        elif isinstance(value, dict):
            raw_ids = value.get("previous_source_ids", [])
            if isinstance(raw_ids, (str, int)):
                raw_ids = [raw_ids]
            state = cls(
                conversation_id=str(value.get("conversation_id") or conversation_id or ""),
                active_office=_normalize_office(value.get("active_office")),
                active_topic=_clean_text(value.get("active_topic")),
                scope_verified=bool(value.get("scope_verified", False)),
                previous_user_query=_clean_text(value.get("previous_user_query")),
                previous_standalone_query=_clean_text(value.get("previous_standalone_query")),
                previous_source_ids=[str(x) for x in raw_ids if x not in (None, "")][:20],
                conversation_summary=_clean_text(value.get("conversation_summary")),
                last_updated_at=str(value.get("last_updated_at") or ""),
            )
        else:
            state = cls(conversation_id=conversation_id or "")
        if conversation_id and not state.conversation_id:
            state.conversation_id = conversation_id
        if state.active_office not in VALID_OFFICES:
            state.active_office = None
        return state

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ConversationResolution:
    is_followup: bool = False
    topic_changed: bool = False
    standalone_query: str = ""
    inherited_office: str | None = None
    topic: str | None = None
    ambiguity: bool = False
    ambiguity_reason: str | None = None
    confidence: float = 0.0

    @classmethod
    def from_value(cls, value: Any) -> "ConversationResolution":
        if not isinstance(value, dict):
            return cls()
        confidence = _clamp_confidence(value.get("confidence", 0.0))
        inherited = _normalize_office(value.get("inherited_office"))
        return cls(
            is_followup=_as_bool(value.get("is_followup", False)),
            topic_changed=_as_bool(value.get("topic_changed", False)),
            standalone_query=_clean_text(value.get("standalone_query")) or "",
            inherited_office=inherited,
            topic=_clean_text(value.get("topic")),
            ambiguity=_as_bool(value.get("ambiguity", False)),
            ambiguity_reason=_clean_text(value.get("ambiguity_reason")),
            confidence=confidence,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ScopeDecision:
    status: str = "AMBIGUOUS"
    office_hint: str | None = None
    confidence: float = 0.0
    reason: str = ""

    @classmethod
    def from_value(cls, value: Any) -> "ScopeDecision":
        if not isinstance(value, dict):
            return cls()
        status = str(value.get("status") or "").strip().upper()
        if status not in {"IN_SCOPE", "OUT_OF_SCOPE", "AMBIGUOUS"}:
            status = "AMBIGUOUS"
        return cls(
            status=status,
            office_hint=_normalize_office(value.get("office_hint")),
            confidence=_clamp_confidence(value.get("confidence", 0.0)),
            reason=_clean_text(value.get("reason")) or "",
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EvidenceDecision:
    sufficient: bool
    confidence: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def _clamp_confidence(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _normalize_office(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    aliases = {
        "ope": "ope", "physical education": "ope", "體育室": "ope",
        "ge": "ge", "general education": "ge", "通識教育中心": "ge", "通識中心": "ge",
        "lc": "lc", "language center": "lc", "語言中心": "lc",
        "oaa": "oaa", "academic affairs": "oaa", "教務處": "oaa",
        "osa": "osa", "student affairs": "osa", "學務處": "osa",
        "hr": "hr", "human resources": "hr", "人事室": "hr",
    }
    return aliases.get(text) or (text if text in VALID_OFFICES else None)


def _history_items(history: Iterable[Any] | None) -> list[dict[str, str]]:
    result = []
    for item in history or []:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        result.append({"role": role, "content": content.strip()[:1200]})
    return result


def _last_user_query(history: Iterable[Any] | None) -> str:
    for item in reversed(_history_items(history)):
        if item["role"] == "user":
            return item["content"]
    return ""


def _likely_followup(query: str, history: Iterable[Any] | None, state: ConversationState) -> bool:
    if not (_history_items(history) or state.active_topic):
        return False
    text = query.strip().lower()
    return len(text) <= 24 or any(marker.lower() in text for marker in FOLLOWUP_MARKERS)


def _parse_json_object(text: Any) -> dict[str, Any]:
    if not isinstance(text, str):
        raise ValueError("structured output is not text")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.I | re.S).strip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("structured output has no JSON object")
        value = json.loads(cleaned[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("structured output is not a JSON object")
    return value


def _complete_json(
    complete_fn: Callable[..., str],
    messages: list[dict[str, str]],
    *,
    max_tokens: int,
    retries: int,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for _ in range(max(1, retries + 1)):
        try:
            try:
                output = complete_fn(
                    messages,
                    temperature=0,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                )
            except TypeError as exc:
                # Keep the module usable with a small test double or an older
                # adapter that has not yet exposed response_format.
                if "response_format" not in str(exc):
                    raise
                output = complete_fn(messages, temperature=0, max_tokens=max_tokens)
            return _parse_json_object(output)
        except Exception as exc:  # provider errors and malformed JSON are retryable
            last_error = exc
    raise last_error or ValueError("structured output failed")


def _resolver_prompt(current_query: str, history: list[dict[str, str]], state: ConversationState) -> list[dict[str, str]]:
    state_json = json.dumps(state.to_dict(), ensure_ascii=False)
    history_json = json.dumps(history[-10:], ensure_ascii=False)
    system = (
        "你是國立臺北大學行政服務 AI 的 Conversation Context Resolver。"
        "你只負責理解目前這句話與前文的關係，不回答使用者問題。\n"
        "請判斷是否為追問、是否切換主題，並將目前問題改寫成不依賴前文的完整 standalone_query。"
        "短句、省略主詞或含有『那／呢／這個／多久／要幾分／怎麼申請』不代表超出服務範圍。"
        "若前文能補足語意，必須視為追問；若補足後仍有實質不同的解釋，ambiguity=true。"
        "不得創造前文不存在的條件。只輸出符合 schema 的 JSON。\n\n"
        "schema={is_followup:boolean, topic_changed:boolean, standalone_query:string, "
        "inherited_office:string|null, topic:string|null, ambiguity:boolean, "
        "ambiguity_reason:string|null, confidence:number}"
    )
    user = (
        f"目前問題：{current_query[:1000]}\n"
        f"Conversation State：{state_json}\n"
        f"Conversation History：{history_json}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _fallback_resolution(current_query: str, history: list[dict[str, str]], state: ConversationState) -> ConversationResolution:
    previous = state.active_topic or state.previous_standalone_query or _last_user_query(history)
    followup = _likely_followup(current_query, history, state)
    if followup and previous:
        standalone = f"{previous}：{current_query.strip()}"
        topic = state.active_topic or previous
    else:
        standalone = current_query.strip()
        topic = state.active_topic if state.active_topic and not current_query.strip() else current_query.strip() or state.active_topic
    return ConversationResolution(
        is_followup=followup,
        topic_changed=False,
        standalone_query=standalone,
        inherited_office=state.active_office if followup else None,
        topic=topic,
        confidence=0.55 if followup else 0.45,
    )


def resolve_conversation(
    current_query: str,
    history: Iterable[Any] | None,
    state: ConversationState | dict[str, Any] | None,
    complete_fn: Callable[..., str],
    *,
    retries: int = 1,
) -> ConversationResolution:
    """Resolve a raw turn before any business-scope decision is made."""
    current_query = (current_query or "").strip()
    history_items = _history_items(history)
    state_obj = ConversationState.from_value(state)
    try:
        parsed = _complete_json(
            complete_fn,
            _resolver_prompt(current_query, history_items, state_obj),
            max_tokens=400,
            retries=retries,
        )
        result = ConversationResolution.from_value(parsed)
    except Exception:
        return _fallback_resolution(current_query, history_items, state_obj)

    has_context = bool(history_items or state_obj.active_topic)
    if not has_context:
        result.is_followup = False
        result.topic_changed = False
        result.inherited_office = None
    elif _likely_followup(current_query, history_items, state_obj) and not result.topic_changed:
        # A model occasionally labels a four-word continuation as a new query.
        # The conservative correction prevents the old raw-short-query bug.
        result.is_followup = True

    topic_hint = state_obj.active_topic or _last_user_query(history_items)
    if result.is_followup and not result.topic_changed:
        if not result.inherited_office:
            result.inherited_office = state_obj.active_office
        if not result.topic:
            result.topic = topic_hint
        if result.standalone_query.strip() in {"", current_query} and topic_hint:
            result.standalone_query = f"{topic_hint}：{current_query}"
    if not result.standalone_query:
        result.standalone_query = current_query
    if not result.topic:
        result.topic = topic_hint or current_query or None
    if result.topic_changed:
        result.inherited_office = None
    return result


def _scope_prompt(standalone_query: str, context: dict[str, Any]) -> list[dict[str, str]]:
    supported = "；".join(f"{code}={name}" for code, name in OFFICE_NAMES.items())
    system = (
        "你是 NTPU 行政服務 AI 的 Business Scope Guardrail。"
        "你只能判斷問題是否屬於支援範圍，不回答問題。\n"
        f"支援處室：{supported}。一般問候或系統功能詢問也算 IN_SCOPE，office_hint 可為 null。\n"
        "資訊不足但仍與支援校務主題有關時回 AMBIGUOUS，不得把資訊不足當 OUT_OF_SCOPE。"
        "只有完整語意確認與所有支援服務無關時才回 OUT_OF_SCOPE。"
        "只輸出 JSON：{status:'IN_SCOPE|OUT_OF_SCOPE|AMBIGUOUS', office_hint:string|null, confidence:number, reason:string}。"
    )
    user = (
        f"standalone_query：{standalone_query[:1200]}\n"
        f"context：{json.dumps(context, ensure_ascii=False)}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _lexical_scope(standalone_query: str, context: dict[str, Any]) -> ScopeDecision:
    text = (standalone_query or "").strip().lower()
    if text in {phrase.lower() for phrase in CHAT_PHRASES}:
        return ScopeDecision("IN_SCOPE", None, 0.98, "一般對話或系統功能詢問。")

    matched = []
    for office, keywords in OFFICE_KEYWORDS.items():
        if any(keyword.lower() in text for keyword in keywords):
            matched.append(office)
    matched = list(dict.fromkeys(matched))
    if len(matched) == 1:
        return ScopeDecision("IN_SCOPE", matched[0], 0.72, f"關鍵詞與{OFFICE_NAMES[matched[0]]}相關。")
    if len(matched) > 1:
        return ScopeDecision("AMBIGUOUS", None, 0.55, "問題同時涉及多個可能的服務處室。")

    active = _normalize_office(context.get("active_office"))
    if active and len(text) <= 24:
        return ScopeDecision("AMBIGUOUS", active, 0.45, "目前問題仍需依對話上下文補充。")
    return ScopeDecision("OUT_OF_SCOPE", None, 0.35, "完整問題與目前支援的校務服務無明確關聯。")


def run_scope_guardrail(
    standalone_query: str,
    context: dict[str, Any] | None,
    complete_fn: Callable[..., str],
    *,
    retries: int = 1,
) -> ScopeDecision:
    """Classify the already-resolved query into the three SDD scope states."""
    context = context or {}
    try:
        result = ScopeDecision.from_value(
            _complete_json(
                complete_fn,
                _scope_prompt(standalone_query, context),
                max_tokens=220,
                retries=retries,
            )
        )
        # The structured classifier is authoritative when it has a clear
        # answer, but a malformed/overly conservative model response must not
        # reintroduce the short-follow-up bug. The lexical check only promotes
        # an answer when the resolved query has an unambiguous supported term.
        lexical = _lexical_scope(standalone_query, context)
        has_context = bool(context.get("active_topic") or context.get("active_office"))
        if (
            result.status == "OUT_OF_SCOPE"
            and has_context
            and lexical.status != "OUT_OF_SCOPE"
        ):
            return lexical
        if result.status == "AMBIGUOUS" and lexical.status == "IN_SCOPE":
            return lexical
        return result
    except Exception:
        return _lexical_scope(standalone_query, context)


def select_office(
    resolution: ConversationResolution,
    scope: ScopeDecision,
    state: ConversationState,
    threshold: float = 0.80,
) -> str | None:
    """Inherit an office only for a high-confidence same-topic continuation."""
    inherited = _normalize_office(resolution.inherited_office) or state.active_office
    if (
        resolution.is_followup
        and not resolution.topic_changed
        and inherited
        and resolution.confidence >= threshold
        and (not scope.office_hint or scope.office_hint == inherited)
    ):
        return inherited
    if scope.office_hint:
        return scope.office_hint
    if scope.status == "IN_SCOPE":
        lexical = _lexical_scope(resolution.standalone_query, {})
        if lexical.status == "IN_SCOPE":
            return lexical.office_hint
    return None


def build_updated_state(
    state: ConversationState,
    *,
    conversation_id: str,
    raw_query: str,
    resolution: ConversationResolution,
    scope: ScopeDecision,
    selected_office: str | None,
    source_ids: Iterable[Any] = (),
    updated_at: str = "",
) -> ConversationState:
    source_list = [str(x) for x in source_ids if x not in (None, "")]
    source_list = list(dict.fromkeys(source_list))[:20]
    active_office = _normalize_office(selected_office)
    if not active_office and not resolution.topic_changed:
        active_office = state.active_office
    active_topic = resolution.topic or state.active_topic or resolution.standalone_query or raw_query
    return ConversationState(
        conversation_id=conversation_id or state.conversation_id,
        active_office=active_office,
        active_topic=active_topic,
        scope_verified=scope.status == "IN_SCOPE",
        previous_user_query=raw_query,
        previous_standalone_query=resolution.standalone_query,
        previous_source_ids=source_list,
        conversation_summary=state.conversation_summary,
        last_updated_at=updated_at,
    )


def clarification_text(resolution: ConversationResolution, scope: ScopeDecision) -> str:
    topic = resolution.topic or "這個校務主題"
    reason = resolution.ambiguity_reason or scope.reason
    if reason:
        return f"你的問題看起來與「{topic}」有關，但目前還需要一點資訊才能確認。請補充你要詢問的檢定、身分、學制或具體項目。"
    return f"你的問題看起來與「{topic}」有關，但目前還無法判斷你要查詢的具體項目，請再補充說明。"


def _terms(text: str) -> set[str]:
    terms: set[str] = set()
    for token in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9_]+", (text or "").lower()):
        if re.fullmatch(r"[\u4e00-\u9fff]+", token):
            if len(token) >= 2:
                terms.add(token)
                terms.update(token[i:i + 2] for i in range(len(token) - 1))
        elif len(token) >= 2:
            terms.add(token)
    return terms


def check_evidence_sufficiency(query: str, documents: Iterable[Any]) -> EvidenceDecision:
    """Conservative, deterministic post-rerank evidence gate.

    The retrieval layer already selected the documents semantically. This gate
    requires at least one meaningful query term to be visible in the selected
    evidence before the Agent may present it as an answer.
    """
    docs = [doc for doc in documents if getattr(doc, "page_content", "")]
    if not docs:
        return EvidenceDecision(False, 0.0, "沒有檢索到可用文件。")
    query_terms = _terms(query)
    if not query_terms:
        return EvidenceDecision(True, 0.60, "問題沒有可比對的內容詞，但檢索已取得文件。")

    evidence_terms: set[str] = set()
    exact = False
    query_text = (query or "").strip().lower()
    for doc in docs[:5]:
        content = (getattr(doc, "page_content", "") or "").lower()
        metadata = getattr(doc, "metadata", {}) or {}
        title = str(metadata.get("title", "")).lower()
        if query_text and (query_text in content or query_text in title):
            exact = True
        evidence_terms.update(_terms(content + " " + title))
    overlap = query_terms & evidence_terms
    if exact:
        return EvidenceDecision(True, 0.95, "檢索文件直接包含完整問題或文件標題。")
    if len(overlap) >= 2:
        return EvidenceDecision(True, min(0.90, 0.55 + len(overlap) * 0.05), "檢索文件包含多個問題關鍵詞。")
    if len(overlap) == 1:
        return EvidenceDecision(True, 0.60, "檢索文件包含至少一個問題關鍵詞，仍應以原文保守回答。")
    return EvidenceDecision(False, 0.25, "檢索文件與完整問題缺乏可確認的關鍵詞交集。")
