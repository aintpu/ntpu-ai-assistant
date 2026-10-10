"""回答前檢查證據（老師建議 二-2）。

1. 回答模型在答案最後另起一行輸出「【引文】」與 JSON，列出支持答案的原文句子（使用者 2026-10-10 選定由模型標出引文）。
   串流時這一段不送到前端；答案完成後由程式確認每句引文確實逐字出現在該來源裡，找不到的不顯示。
2. 引用卡片：答案引用的每個來源都列成卡片並附上確認過的原文片段（使用者選定：內文已有連結的也列）。
3. 回答後再檢查：分類模型確認答案裡的人物、職務、日期、數字都有原文直接支持、來源之間沒有衝突；
   不通過就改成「無法確認」並說明原因（使用者選定：回答後再檢查）。
"""
import json
import re
from typing import Callable, Dict, List, Tuple

QUOTE_MARKER = "【引文】"

QUOTE_INSTRUCTION = (
    "\n\n【引文標註（系統用，使用者看不到）】若答案使用了工具回傳的文件，請在答案全部寫完後另起一行輸出「"
    + QUOTE_MARKER
    + "」，下一行輸出一個 JSON 陣列，列出直接支持答案的原文句子："
    '[{"source": "文件名稱（照【文件名稱】原樣）", "quote": "從該文件【文件內容】逐字複製的一句，最多 80 字"}]。'
    "quote 必須逐字複製原文，不可改寫、翻譯或合併多句；每個用到的文件最多 2 句。"
    "沒有使用任何文件（例如查無資料、只是請使用者補充）時不要輸出這一段。"
)

QUOTE_MAX_CHARS = 120


class QuoteStreamFilter:
    """串流時把「【引文】」之後的內容擋下，不送到前端。"""

    def __init__(self):
        self._pending = ""
        self._hidden = False

    def feed(self, chunk: str) -> str:
        if self._hidden:
            return ""
        text = self._pending + (chunk or "")
        at = text.find(QUOTE_MARKER)
        if at >= 0:
            self._hidden = True
            self._pending = ""
            return text[:at].rstrip()
        # 結尾可能是標記的前半段（例如「【引」），先留著等下一段
        keep = 0
        for size in range(min(len(QUOTE_MARKER) - 1, len(text)), 0, -1):
            if QUOTE_MARKER.startswith(text[-size:]):
                keep = size
                break
        self._pending = text[len(text) - keep:] if keep else ""
        return text[:len(text) - keep] if keep else text

    def flush(self) -> str:
        out, self._pending = ("" if self._hidden else self._pending), ""
        return out


def split_quotes(answer: str) -> Tuple[str, List[dict]]:
    """拆出答案本文與模型標出的引文（格式不對就當作沒有引文）。"""
    text = answer or ""
    at = text.find(QUOTE_MARKER)
    if at < 0:
        return text, []
    body, tail = text[:at].rstrip(), text[at + len(QUOTE_MARKER):]
    m = re.search(r"\[.*\]", tail, re.S)
    quotes = []
    if m:
        try:
            data = json.loads(m.group(0))
        except ValueError:
            data = []
        for q in data if isinstance(data, list) else []:
            if isinstance(q, dict) and isinstance(q.get("quote"), str) and q["quote"].strip():
                quotes.append({"source": str(q.get("source") or "").strip(), "quote": q["quote"].strip()})
    return body, quotes


def _norm(text: str) -> str:
    """比對用：去掉空白與 Markdown 粗體、全形半形標點差異不影響逐字比對的部分。"""
    text = re.sub(r"\*\*|__|`", "", text or "")
    return re.sub(r"\s+", "", text)


def _strip_quote(quote: str) -> str:
    return quote.strip().strip("「」『』\"'“”…").strip()


def match_quotes(quotes: List[dict], candidates: List[dict]) -> Dict[str, str]:
    """回傳 {source_id: 原文片段}：只收逐字出現在該來源內容裡的引文（找不到的不顯示，不讓模型編的句子變成「原文」）。"""
    out: Dict[str, str] = {}
    for q in quotes:
        quote = _strip_quote(q.get("quote", ""))
        nq = _norm(quote)
        if len(nq) < 4:
            continue
        named = [c for c in candidates if q.get("source") and _norm(q["source"]) in _norm(c.get("title", ""))]
        for c in named + [c for c in candidates if c not in named]:
            sid = c.get("source_id") or c.get("url") or c.get("title")
            if sid and nq in _norm(c.get("content", "")):
                if sid not in out:
                    out[sid] = quote[:QUOTE_MAX_CHARS] + ("…" if len(quote) > QUOTE_MAX_CHARS else "")
                elif quote not in out[sid] and len(out[sid]) < QUOTE_MAX_CHARS * 2:
                    out[sid] += "／" + quote[:QUOTE_MAX_CHARS]
                break
    return out


CHECK_DOC_CHARS = 6000  # 每份文件最多給查核模型看多少字
CHECK_EVIDENCE_CHARS = 24000  # 全部證據的總字數上限

CHECK_PROMPT = """你是回答前的證據查核員。判斷「系統回答」中的具體事實是否都有「證據」直接支持。
具體事實指：人名、職務對應（誰擔任什麼）、有效時間（現任、任期、日期、期限）、數字、金額、地點、條件。
- supported=false：回答有任何具體事實在證據裡找不到直接支持（例如證據只寫曾任，回答卻說現任；證據沒寫的日期或數字）。
- conflict=true：證據之間對同一件事說法互相矛盾（例如兩份文件寫不同人是現任），而回答直接選了其中一個下定論。
- 回答只是換句話說、摘要、省略細節，或明說查不到、建議洽詢，都算 supported=true。
- 回答提到「資料來源」「官方介紹頁」等引用說明不算具體事實。
只輸出 JSON：{"supported": true|false, "conflict": true|false, "reason": "20 字內，說明哪一項沒有證據或哪裡衝突"}"""


def check_answer(question: str, answer: str, evidence: List[dict],
                 complete_fn: Callable[..., str]) -> dict:
    """回答後檢查證據。模型呼叫失敗或輸出無法解析時視為通過（不因查核故障擋掉答案），並註記 error。"""
    blocks, budget = [], CHECK_EVIDENCE_CHARS
    for e in evidence[:10]:
        piece = f"【{e.get('title', '')}】"
        if e.get("quote"):
            piece += f"\n原文片段：{e['quote']}"
        # 答案常引用文件後段（例如公告最後才寫獎金），只給開頭會誤判成「證據沒有」
        content = (e.get("content") or "")[:min(CHECK_DOC_CHARS, max(budget, 0))]
        budget -= len(content)
        piece += f"\n內容：{content}"
        blocks.append(piece)
    msgs = [
        {"role": "system", "content": CHECK_PROMPT},
        {"role": "user", "content": f"使用者問題：{question}\n\n證據：\n" + "\n\n".join(blocks)
                                    + f"\n\n系統回答：{answer[:3000]}"},
    ]
    try:
        raw = complete_fn(msgs, temperature=0, max_tokens=300, response_format={"type": "json_object"})
        m = re.search(r"\{.*\}", raw or "", re.S)
        data = json.loads(m.group(0)) if m else None
    except Exception as exc:  # noqa: BLE001 - 查核故障不擋答案
        return {"supported": True, "conflict": False, "reason": "", "error": type(exc).__name__}
    if not isinstance(data, dict):
        return {"supported": True, "conflict": False, "reason": "", "error": "unparsable"}
    return {"supported": data.get("supported") is not False, "conflict": data.get("conflict") is True,
            "reason": str(data.get("reason") or "")[:60]}


def unconfirmed_answer(reason: str, conflict: bool, language: str) -> str:
    """證據不足或衝突時取代原答案：停止斷言，明確說明無法確認。"""
    if language == "en":
        why = "the sources conflict with each other" if conflict else "the sources do not directly support every detail"
        return (f"I can't confirm this answer: {why}" + (f" ({reason})" if reason else "") + ". "
                "Please check the official sources listed below or contact the office directly.")
    why = "查到的資料彼此說法不一致" if conflict else "查到的資料沒有直接寫明答案裡的每一項內容"
    return (f"目前無法確認這個問題的答案：{why}" + (f"（{reason}）" if reason else "") + "。"
            "為避免誤導，我不下定論；請以下方列出的官方來源原文為準，或直接洽詢承辦單位。")


def needs_check(answer: str, evidence: List[dict], no_answer_hints) -> bool:
    """有用到文件、且不是查無資料的回覆才需要檢查。"""
    return bool(evidence) and bool((answer or "").strip()) and not any(h in answer for h in no_answer_hints)


__all__ = [
    "QUOTE_MARKER", "QUOTE_INSTRUCTION", "QuoteStreamFilter", "split_quotes", "match_quotes",
    "check_answer", "unconfirmed_answer", "needs_check",
]
