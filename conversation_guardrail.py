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


VALID_OFFICES = {"ope", "ge", "lc", "oaa", "osa", "hr", "oga"}
OFFICE_NAMES = {
    "ope": "體育室",
    "ge": "通識教育中心",
    "lc": "語言中心",
    "oaa": "教務處",
    "osa": "學務處",
    "hr": "人事室",
    "oga": "總務處",
}

OFFICE_KEYWORDS = {
    "ope": (
        "體育", "運動", "場地", "體育館", "崇越館", "課表", "賽事", "競賽",
        "全大運", "系際盃", "器材", "運動獎學金", "健身", "體能", "肌力", "熱身", "伸展",
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
        "社團", "兵役", "心理諮商", "健康中心", "學生保險", "學生團體保險",
        "團體保險", "學生平安保險",
    ),
    "hr": (
        "人事", "差勤", "刷卡", "請假", "事假", "病假", "身心調適假", "婚假",
        "產假", "陪產假", "喪假", "勞基法", "變形工時", "行政人員", "午休",
        "差假", "勤休", "特休", "特別休假", "休假天數", "補休",
    ),
    "oga": (
        "總務", "營繕", "設備報修", "報修", "緊急修繕", "停電", "停水", "空調", "冷氣", "採購",
        "施工", "重大建設", "用電資訊", "電話分機", "網路插孔", "場地線上登記",
        "場地借用申請表", "環保標章", "校園賣店", "公務車",
        "共同供應契約", "綠色採購", "科研採購", "財物", "財產盤點", "盤點", "財物報廢",
        "資產經營管理", "校內空間", "校地", "校舍", "職務宿舍", "學位服", "消耗品",
        "學雜費繳費單", "繳費單顯示", "多元支付", "出納", "所得清冊",
        "貨款", "款項是否已入帳", "公教存款", "所得稅扣繳", "汽車停車證", "機車停車證", "腳踏車停車證",
        "校園交通", "職業安全衛生", "監視器", "電子公文", "文件流程控管",
        "待領郵件", "檔案檢調", "調閱校內檔案", "郵局搬遷", "校內郵務", "公文無紙化", "校園地圖",
    ),
}

OFFICE_PRIORITY_KEYWORDS = {
    "oga": (
        "場地線上登記", "場地借用申請表", "學雜費繳費單", "線上繳費暨多元支付",
        "文件流程控管", "公教優惠存款", "職務宿舍", "學位服",
        "汽車應該停", "機車應該停", "腳踏車應該停",
    ),
}

# High-precision intents that are clearly outside the seven supported offices.
# These are deliberately narrower than a general keyword denylist: an unknown
# paraphrase may still be accepted by the semantic scope classifier, while
# known unrelated topics cannot be opened by an over-optimistic model result.
EXPLICIT_UNSUPPORTED_PATTERNS = (
    ("天氣或氣象", re.compile(r"天氣|氣象|下雨|降雨|氣溫|weather|forecast", re.IGNORECASE)),
    (
        "餐廳或美食推薦",
        re.compile(
            r"(?:推薦|附近|哪間|哪家|吃什麼|好吃).{0,12}(?:餐廳|美食|餐點|宵夜)"
            r"|(?:餐廳|美食|餐點|宵夜).{0,12}(?:推薦|附近|哪間|哪家|好吃)",
            re.IGNORECASE,
        ),
    ),
    ("投資或市場行情", re.compile(r"比特幣|虛擬貨幣|加密貨幣|股票|股價|匯率|投資標的", re.IGNORECASE)),
    (
        "程式撰寫",
        re.compile(
            r"\b(?:python|javascript|typescript|java|c\+\+|sql)\b"
            r"|(?:寫|產生|生成|除錯).{0,8}(?:程式|程式碼|code)|\bdebug\b",
            re.IGNORECASE,
        ),
    ),
    ("旅遊規劃", re.compile(r"機票|訂房|飯店推薦|旅遊景點|行程規劃", re.IGNORECASE)),
)

SEMANTIC_SCOPE_CONFIDENCE = 0.82

# Service-boundary configuration.  The guardrail is intentionally expressed in
# terms of a supported service entity rather than a school-specific rule: the
# same mechanism can be reused by another corpus by replacing these aliases.
DEFAULT_SERVICE_ENTITY_ALIASES = (
    "國立臺北大學", "國立台北大學", "臺北大學", "台北大學", "NTPU", "北大",
)
# Short aliases cannot be recognized reliably from a suffix pattern alone.
# Keep only high-precision competing aliases here; full organization names are
# detected generically below and the structured scope classifier handles other
# named entities.
DEFAULT_EXTERNAL_ENTITY_ALIASES = (
    "台大", "臺大", "NTU", "National Taiwan University",
)
ENTITY_SUFFIXES = (
    "大學", "學院", "高中", "國中", "國小", "學校", "研究院",
    "公司", "銀行", "醫院", "市政府", "縣政府", "區公所",
)
ENTITY_FILLERS = (
    "那請問", "請問", "想問", "我要問", "幫我查", "查詢", "如何查詢", "收到",
    "關於", "有關", "請教",
)
GENERIC_ENTITY_CANDIDATES = {
    "學生", "本校", "我校", "校內", "校外", "相關", "大學", "學校",
    "宿舍", "住宿", "規定", "辦法", "流程", "服務", "系統",
}
_CJK_ENTITY_RE = re.compile(
    r"(?P<entity>[\u4e00-\u9fff]{2,24}(?:" + "|".join(ENTITY_SUFFIXES) + r"))"
)
_EN_ENTITY_RE = re.compile(
    r"(?P<entity>\b(?:[A-Za-z][A-Za-z0-9&.\-]*\s+){1,5}"
    r"(?:University|College|School|Company|Bank|Hospital|Government)\b)",
    re.IGNORECASE,
)

CHAT_PHRASES = {
    "你好", "嗨", "哈囉", "hello", "hi", "謝謝", "謝謝你", "感謝", "好的",
    "好", "了解", "收到", "沒問題", "你是誰", "你能做什麼",
}
FOLLOWUP_MARKERS = (
    "那", "這個", "這樣", "它", "這些", "呢", "嗎", "可以嗎", "要幾分",
    "多久", "怎麼申請", "要去哪裡", "還有其他", "什麼時候", "需要什麼",
)
CONTEXT_FOLLOWUP_BASES = (
    "這個", "這樣", "它", "這些", "可以嗎", "要幾分", "多久", "怎麼申請",
    "要去哪裡", "還有其他", "什麼時候", "需要什麼", "多少", "多少錢", "幾點",
    "哪裡", "怎麼辦", "有沒有", "有哪些", "要什麼", "何時", "如何",
    "費用多少", "還有嗎", "還有哪些",
)
CONTEXT_FOLLOWUP_SUFFIXES = (
    "證明", "文件", "資料", "條件", "要求", "方式", "流程", "規定", "時間", "日期", "費用", "資格",
    "規定的申請方式", "流程怎麼走", "還有嗎", "還有哪些",
)

# A user often answers a clarification with only the missing value, for example
# "我5年", "600分", "2學分" or "我是聘僱人員".  These are safe to inherit only
# when the previous turn already established a verified supported-office topic.
_CONTEXT_NUMBER = r"(?:\d+(?:\.\d+)?|[零〇一二兩三四五六七八九十百千半]+)"
_CONTEXT_VALUE_REPLY_RE = re.compile(
    rf"^(?:我|本人|我的|本人的)?"
    rf"(?:年資|服務|成績|分數|學分|費用|金額|年級)?"
    rf"(?:是|有|為|已|已經|目前|約|大約|滿)?"
    rf"{_CONTEXT_NUMBER}"
    rf"(?:年|個月|月|日|天|小時|分鐘|分|學分|元|歲|學期|次|門|人|級)"
    rf"(?:左右|以上|以下|未滿|多|整)?$"
)
_CONTEXT_CATEGORY_REPLY_RE = re.compile(
    r"^(?:我|本人)?(?:是|屬於|讀|念)?"
    r"(?:聘僱人員|約用人員|公務人員|教職員|教師|學生|大學生|研究生|"
    r"碩士生|博士生|在職專班|大[一二三四五六]|碩[一二三]|博[一二三四五六]|"
    r"本國籍|外籍生|僑生|交換生)$"
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
    entity_conflict: bool = False
    entity_hint: str | None = None

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
            entity_conflict=_as_bool(value.get("entity_conflict", False)),
            entity_hint=_clean_text(value.get("entity_hint")),
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
        "oga": "oga", "general affairs": "oga", "總務處": "oga",
    }
    return aliases.get(text) or (text if text in VALID_OFFICES else None)


def _normalize_entity_text(value: Any) -> str:
    """Normalize an entity mention without changing ordinary query text."""
    if not isinstance(value, str):
        return ""
    normalized = re.sub(r"[\s\-_（）()·．.。，、：:；;！？!?「」『』\"']+", "", value)
    return normalized.casefold().replace("台", "臺")


def _contains_entity_alias(text: str, alias: str) -> bool:
    normalized_text = _normalize_entity_text(text)
    normalized_alias = _normalize_entity_text(alias)
    if not normalized_text or not normalized_alias:
        return False
    if re.fullmatch(r"[a-z0-9]+", normalized_alias):
        return bool(re.search(
            rf"(?<![a-z0-9]){re.escape(normalized_alias)}(?![a-z0-9])",
            normalized_text,
            flags=re.IGNORECASE,
        ))
    return normalized_alias in normalized_text


def _configured_aliases(
    context: dict[str, Any],
    key: str,
    default: Iterable[str],
) -> tuple[str, ...]:
    value = context.get(key)
    if value is None:
        value = default
    if isinstance(value, str):
        value = (value,)
    try:
        return tuple(str(alias).strip() for alias in value if str(alias).strip())
    except TypeError:
        return tuple(str(alias).strip() for alias in default if str(alias).strip())


def _clean_entity_candidate(value: str) -> str:
    candidate = (value or "").strip()
    for filler in sorted(ENTITY_FILLERS, key=len, reverse=True):
        if candidate.startswith(filler):
            candidate = candidate[len(filler):].strip()
    return candidate.strip("，、：:；;！？!?「」『』 ")


def _extract_entity_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    for pattern in (_CJK_ENTITY_RE, _EN_ENTITY_RE):
        for match in pattern.finditer(text or ""):
            candidate = _clean_entity_candidate(match.group("entity"))
            normalized = _normalize_entity_text(candidate)
            if not candidate or normalized in {
                _normalize_entity_text(item) for item in GENERIC_ENTITY_CANDIDATES
            }:
                continue
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates


def detect_service_entity_conflict(
    query: str,
    *,
    supported_aliases: Iterable[str] = DEFAULT_SERVICE_ENTITY_ALIASES,
    external_aliases: Iterable[str] = DEFAULT_EXTERNAL_ENTITY_ALIASES,
) -> str | None:
    """Return an explicit competing service entity, if one is present.

    This is deliberately high precision.  It catches configured short aliases
    and organization names with common entity suffixes; the LLM scope
    classifier supplies the broader semantic check for names that cannot be
    safely identified by a lexical rule.
    """
    text = query or ""
    supported = tuple(alias for alias in supported_aliases if alias)
    for alias in external_aliases:
        if alias and _contains_entity_alias(text, alias):
            return str(alias)

    for candidate in _extract_entity_candidates(text):
        if any(_contains_entity_alias(candidate, alias) for alias in supported):
            continue
        return candidate
    return None


def detect_explicit_unsupported_intent(query: str) -> str | None:
    """Return a high-precision unrelated topic without treating silence as denial."""
    text = (query or "").strip()
    for label, pattern in EXPLICIT_UNSUPPORTED_PATTERNS:
        if pattern.search(text):
            return label
    return None


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


def _is_context_only_followup(query: str) -> bool:
    text = re.sub(r"[\s，、：:；;！？!?。]+", "", (query or "").strip().lower())
    if not text:
        return False
    prefixes = ("", "那")
    for prefix in prefixes:
        for base in CONTEXT_FOLLOWUP_BASES:
            stem = prefix + base
            if text == stem:
                return True
            if text.startswith(stem):
                suffix = text[len(stem):]
                if suffix in CONTEXT_FOLLOWUP_SUFFIXES:
                    return True
            if text == stem + "呢" or text == stem + "嗎" or text == stem + "可以嗎":
                return True
    return text in {"呢", "嗎", "好嗎", "這個呢", "那這個呢"}


def _is_compact_context_reply(query: str) -> bool:
    """Return whether a short turn looks like a value/category supplied to the prior topic."""
    text = re.sub(r"[\s，、：:；;！？!?。]+", "", (query or "").strip().lower())
    if not text or len(text) > 24:
        return False
    return bool(
        _CONTEXT_VALUE_REPLY_RE.fullmatch(text)
        or _CONTEXT_CATEGORY_REPLY_RE.fullmatch(text)
    )


def _has_explicit_context_reference(query: str) -> bool:
    """Return whether the current turn explicitly points back to prior context."""
    text = re.sub(r"^[\s，、：:；;！？!?。]+", "", (query or "").strip().lower())
    return text.startswith((
        "那", "那麼", "這", "這個", "這項", "上述", "前面", "剛才", "同樣", "也",
    ))


def _likely_followup(query: str, history: Iterable[Any] | None, state: ConversationState) -> bool:
    if not (_history_items(history) or state.active_topic):
        return False
    if _is_context_only_followup(query):
        return True
    return bool(
        state.scope_verified
        and state.active_office in VALID_OFFICES
        and state.active_topic
        and _is_compact_context_reply(query)
    )


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
        "若上一輪已確認校務主題，『我5年／600分／2學分／我是聘僱人員』等短句通常是補充條件，"
        "應結合上一輪主題改寫成完整問題。"
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
    raw_scope = _lexical_scope(current_query, {})
    self_contained_supported_query = bool(
        raw_scope.status == "IN_SCOPE"
        and raw_scope.office_hint in VALID_OFFICES
        and not _is_context_only_followup(current_query)
        and not _is_compact_context_reply(current_query)
        and not _has_explicit_context_reference(current_query)
    )
    compact_verified_followup = bool(
        state_obj.scope_verified
        and state_obj.active_office in VALID_OFFICES
        and state_obj.active_topic
        and _is_compact_context_reply(current_query)
    )
    if not has_context:
        result.is_followup = False
        result.topic_changed = False
        result.inherited_office = None
    elif self_contained_supported_query:
        # A complete supported-service question must stand on its own.  This
        # prevents an old hidden session value (for example "我7年") from being
        # silently injected into a later visible question about annual leave.
        result.is_followup = False
        result.topic_changed = bool(
            state_obj.active_topic
            and _normalize_entity_text(state_obj.active_topic)
            != _normalize_entity_text(current_query)
        )
        result.standalone_query = current_query
        result.inherited_office = None
        result.topic = current_query
        result.ambiguity = False
        result.ambiguity_reason = None
        result.confidence = max(result.confidence, 0.90)
    elif compact_verified_followup:
        # The structured resolver may interpret a bare value as a new topic.
        # A value/category-only reply is deterministic when it follows a
        # verified supported-office turn, so preserve that context.
        result.is_followup = True
        result.topic_changed = False
        result.inherited_office = state_obj.active_office
        result.topic = state_obj.active_topic
        result.standalone_query = f"{state_obj.active_topic}：{current_query}"
        result.confidence = max(result.confidence, 0.90)
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
    service_aliases = _configured_aliases(
        context,
        "service_entity_aliases",
        DEFAULT_SERVICE_ENTITY_ALIASES,
    )
    service_entities = "、".join(service_aliases)
    raw_query = str(context.get("raw_query") or standalone_query)
    system = (
        "你是 NTPU 行政服務 AI 的 Business Scope Guardrail。"
        "你只能判斷問題是否屬於支援範圍，不回答問題。\n"
        f"服務主體只包含：{service_entities}；支援處室：{supported}。"
        "一般問候或系統功能詢問也算 IN_SCOPE，office_hint 可為 null。\n"
        "如果目前問題明確指向其他學校、公司、機關、地區、產品或服務，"
        "必須回 OUT_OF_SCOPE，entity_conflict=true，不能因為前文有相似主題而繼承原處室。"
        "目前問題的明確指向優先於 active_topic、active_office 與歷史來源。\n"
        "自然語句不一定包含處室名稱；例如行政人員午休、特別休假、差勤等仍屬 hr 人事室，"
        "學生團體保險、學生平安保險等仍屬 osa 學務處。"
        "資訊不足但仍與支援校務主題有關時回 AMBIGUOUS，不得把資訊不足當 OUT_OF_SCOPE。"
        "只有完整語意確認與所有支援服務無關時才回 OUT_OF_SCOPE。"
        "只輸出 JSON：{status:'IN_SCOPE|OUT_OF_SCOPE|AMBIGUOUS', office_hint:string|null, "
        "confidence:number, reason:string, entity_conflict:boolean, entity_hint:string|null}。"
    )
    user = (
        f"原始本輪問題：{raw_query[:1000]}\n"
        f"standalone_query：{standalone_query[:1200]}\n"
        f"context：{json.dumps(context, ensure_ascii=False)}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _lexical_scope(standalone_query: str, context: dict[str, Any]) -> ScopeDecision:
    text = (standalone_query or "").strip().lower()
    if text in {phrase.lower() for phrase in CHAT_PHRASES}:
        return ScopeDecision("IN_SCOPE", None, 0.98, "一般對話或系統功能詢問。")

    explicit = [office for office, name in OFFICE_NAMES.items() if name.lower() in text]
    if len(explicit) == 1:
        office = explicit[0]
        return ScopeDecision("IN_SCOPE", office, 0.96, f"問題明確指定{OFFICE_NAMES[office]}。")

    priority = [
        office for office, keywords in OFFICE_PRIORITY_KEYWORDS.items()
        if any(keyword.lower() in text for keyword in keywords)
    ]
    if len(priority) == 1:
        office = priority[0]
        return ScopeDecision("IN_SCOPE", office, 0.88, f"專屬關鍵詞與{OFFICE_NAMES[office]}相關。")

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
    raw_query = str(context.get("raw_query") or standalone_query)
    service_aliases = _configured_aliases(
        context,
        "service_entity_aliases",
        DEFAULT_SERVICE_ENTITY_ALIASES,
    )
    external_aliases = _configured_aliases(
        context,
        "external_entity_aliases",
        DEFAULT_EXTERNAL_ENTITY_ALIASES,
    )
    boundary_entity = detect_service_entity_conflict(
        raw_query,
        supported_aliases=service_aliases,
        external_aliases=external_aliases,
    )
    if not boundary_entity:
        boundary_entity = detect_service_entity_conflict(
            standalone_query,
            supported_aliases=service_aliases,
            external_aliases=external_aliases,
        )
    if boundary_entity:
        return ScopeDecision(
            "OUT_OF_SCOPE",
            None,
            0.99,
            f"目前問題明確指向「{boundary_entity}」，不屬於本服務主體。",
            True,
            boundary_entity,
        )
    unsupported_intent = detect_explicit_unsupported_intent(raw_query)
    if unsupported_intent:
        return ScopeDecision(
            "OUT_OF_SCOPE",
            None,
            0.98,
            f"本輪問題屬於{unsupported_intent}，不在目前支援的校務服務範圍。",
        )
    has_context = bool(context.get("active_topic") or context.get("active_office"))
    context_only_followup = bool(
        _is_context_only_followup(raw_query)
        or (
            context.get("scope_verified")
            and _normalize_office(context.get("active_office"))
            and context.get("active_topic")
            and _is_compact_context_reply(raw_query)
        )
    )
    classifier_query = standalone_query
    classifier_context = context
    if has_context and not context_only_followup:
        # A resolved query can contain an old topic by design. For a new
        # looking turn, classify the raw wording without the old office/topic
        # so inherited text cannot become scope evidence.
        classifier_query = raw_query
        classifier_context = dict(context)
        classifier_context["active_office"] = None
        classifier_context["active_topic"] = None
    try:
        result = ScopeDecision.from_value(
            _complete_json(
                complete_fn,
                _scope_prompt(classifier_query, classifier_context),
                max_tokens=220,
                retries=retries,
            )
        )
        if result.entity_conflict:
            entity_hint = result.entity_hint or "其他服務主體"
            return ScopeDecision(
                "OUT_OF_SCOPE",
                None,
                max(result.confidence, 0.85),
                result.reason or f"目前問題明確指向「{entity_hint}」，不屬於本服務主體。",
                True,
                entity_hint,
            )
        # The structured classifier is authoritative when it has a clear
        # answer, but a malformed/overly conservative model response must not
        # reintroduce the short-follow-up bug. The lexical check only promotes
        # an answer when the resolved query has an unambiguous supported term.
        resolved_lexical = _lexical_scope(standalone_query, context)
        lexical_query = standalone_query if context_only_followup else raw_query
        lexical_context = context if context_only_followup else {
            "service_entity_aliases": service_aliases,
        }
        lexical = _lexical_scope(lexical_query, lexical_context)
        raw_lexical = _lexical_scope(
            raw_query,
            {"service_entity_aliases": service_aliases},
        )
        inherited_context_only = (
            has_context
            and raw_lexical.status == "OUT_OF_SCOPE"
            and resolved_lexical.status == "IN_SCOPE"
            and not context_only_followup
        )
        if result.status == "OUT_OF_SCOPE" and lexical.status == "IN_SCOPE":
            # The old implementation promoted any short raw query back to the
            # previous office.  That makes an unrelated question such as
            # "那附近的餐廳呢" inherit a dormitory/financial context.  Only
            # high-precision context-only followups may reuse the old topic.
            # A fresh query with an unambiguous supported-service term is safe
            # to promote because explicit external entities and known
            # unrelated intents were already rejected above.
            return result if inherited_context_only else lexical
        if result.status == "AMBIGUOUS" and lexical.status == "IN_SCOPE":
            return result if inherited_context_only else lexical
        if inherited_context_only and result.status == "IN_SCOPE":
            return ScopeDecision(
                "OUT_OF_SCOPE",
                None,
                max(0.82, result.confidence),
                "本輪問題未明確指向支援範圍；上一輪上下文不能作為回答依據。",
            )
        if result.status == "IN_SCOPE" and lexical.status == "OUT_OF_SCOPE":
            # Lexical matching is supporting evidence, not a complete
            # allowlist. Accept a high-confidence semantic mapping to a real
            # office so natural paraphrases can reach retrieval. Explicit
            # external entities and known unrelated intents were denied above.
            if result.office_hint and result.confidence >= SEMANTIC_SCOPE_CONFIDENCE:
                return result
            return ScopeDecision(
                "OUT_OF_SCOPE",
                None,
                max(0.82, result.confidence),
                "本輪問題沒有足夠可信的支援處室訊號，不能交給校務資料庫回答。",
            )
        if (
            result.status == "AMBIGUOUS"
            and lexical.status == "OUT_OF_SCOPE"
            and (not has_context or inherited_context_only)
        ):
            return ScopeDecision(
                "OUT_OF_SCOPE",
                None,
                max(0.78, result.confidence),
                "本輪問題沒有可確認的支援服務訊號，不能交給校務資料庫回答。",
            )
        if (
            result.status == "IN_SCOPE"
            and lexical.status == "IN_SCOPE"
            and result.office_hint
            and lexical.office_hint
            and result.office_hint != lexical.office_hint
            and lexical.confidence >= 0.88
        ):
            # An explicit office name or office-specific workflow phrase is
            # more reliable than a conflicting model guess.  For example,
            # tuition-payment slips belong to OGA cashier FAQs, not OAA rules.
            return lexical
        return result
    except Exception:
        if has_context and not context_only_followup:
            return _lexical_scope(
                raw_query,
                {"service_entity_aliases": service_aliases},
            )
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
    boundary_entity = detect_service_entity_conflict(query)
    if boundary_entity:
        return EvidenceDecision(
            False,
            0.0,
            f"問題指向「{boundary_entity}」，目前檢索服務主體不一致。",
        )

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
