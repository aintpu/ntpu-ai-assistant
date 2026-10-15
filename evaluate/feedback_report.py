"""使用者回饋儀表板：從查詢紀錄（D1 ntpu-aia-query-logs）產生本機 HTML 報表。

    python evaluate/feedback_report.py                 # 最近 30 天 → evaluate/results/feedback_report.html
    python evaluate/feedback_report.py --days 90
    python evaluate/feedback_report.py --open          # 產生後用瀏覽器開啟

報表只存在本機（evaluate/results/ 不進 git）：回饋會對到使用者的提問與回答（寫入前已遮罩電話、Email、身分證號），
不放到任何線上服務。內容：
- 回饋總數、讚／倒讚、滿意度、有文字意見的筆數，以及有回饋的回答占全部回答的比例；
- 倒讚原因分布、各單位的讚／倒讚、每日趨勢；
- 每一筆倒讚與文字意見：點開看提問、改寫後的問題、歸類、引用來源、回答與證據檢查。
"""
import argparse
import json
import os
import sys
import webbrowser
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "evaluate"))

from routing_report import DB, PAGE, detail, esc, office_label, query  # noqa: E402

REASON_NAMES = {
    "wrong_info": "資訊錯誤",
    "outdated": "資訊過時",
    "off_topic": "答非所問",
    "too_vague": "太籠統",
    "bad_source": "出處或連結有誤",
    "other": "其他",
}


def load(since_iso: str) -> list:
    rows, last_id = [], 0
    while True:
        batch = query(
            "SELECT id, event, payload_json FROM query_events "
            f"WHERE id > {last_id} AND ts >= '{since_iso}' AND event IN ('feedback','answer') "
            f"ORDER BY id LIMIT {PAGE}"
        )
        for r in batch:
            try:
                rows.append({"id": r["id"], **json.loads(r["payload_json"])})
            except ValueError:
                continue
        if len(batch) < PAGE:
            return rows
        last_id = batch[-1]["id"]


def as_question(ans: dict) -> dict:
    """回答事件轉成 routing_report.detail() 要的欄位。"""
    office = ans.get("selected_office")
    return {
        "ts": ans.get("ts", ""), "raw": ans.get("raw_query") or "", "standalone": ans.get("standalone_query") or "",
        "result": ans.get("scope_status") or "", "office": None if office in ("other", "system") else office,
        "confidence": ans.get("scope_confidence"), "followup": ans.get("is_followup"),
        "reason": ans.get("scope_reason") or "", "tools": ans.get("tool_calls") or [],
        "sources": ans.get("sources") or [], "answer": ans.get("answer") or "", "check": ans.get("answer_check") or {},
        "latency": ans.get("latency_s"), "message_id": ans.get("message_id") or "", "flags": [],
    }


def build(events: list) -> tuple:
    answers = {e.get("message_id"): e for e in events if e.get("event") == "answer" and e.get("message_id")}
    # 同一則回答可能被按多次（改按倒讚）：以最後一次為準
    latest = {}
    for e in events:
        if e.get("event") == "feedback" and e.get("message_id"):
            latest[e["message_id"]] = e
    feedback = []
    for mid, f in latest.items():
        ans = answers.get(mid)
        feedback.append({
            "ts": f.get("ts", ""), "rating": f.get("rating"), "reasons": f.get("reasons") or [],
            "comment": f.get("comment") or "", "answer": ans,
            "office": (ans or {}).get("selected_office"),
        })
    feedback.sort(key=lambda x: x["ts"], reverse=True)
    return feedback, len(answers)


def item(f: dict) -> str:
    mark = "👍" if f["rating"] == "up" else "👎"
    reasons = "".join(f"<span class='flag'>{esc(REASON_NAMES.get(r, r))}</span>" for r in f["reasons"])
    raw = (f["answer"] or {}).get("raw_query") or "（找不到對應的回答紀錄）"
    body = (f"<p class='comment'>💬 {esc(f['comment'])}</p>" if f["comment"] else "")
    body += detail(as_question(f["answer"])) if f["answer"] else "<p class='meta'>這則回答不在查詢範圍內（可能早於所選天數）。</p>"
    return (f"<details><summary>{mark} <span class='q'>{esc(raw)}</span>{reasons}"
            f"<span class='meta'>　{esc(f['ts'][:16].replace('T', ' '))}</span></summary><div class='d'>{body}</div></details>")


def render(feedback: list, answer_count: int, days: int) -> str:
    up = [f for f in feedback if f["rating"] == "up"]
    down = [f for f in feedback if f["rating"] == "down"]
    comments = [f for f in feedback if f["comment"]]
    total = len(feedback)
    rate = f"{100 * len(up) / total:.0f}%" if total else "—"
    coverage = f"{100 * total / answer_count:.1f}%" if answer_count else "—"
    cards = [("回饋總數", total), ("👍 讚", len(up)), ("👎 倒讚", len(down)), ("滿意度", rate),
             ("文字意見", len(comments)), ("有回饋的回答", f"{coverage}（{total}/{answer_count}）")]

    reasons = Counter(r for f in down for r in f["reasons"])
    top = max(reasons.values() or [1])
    reason_rows = "".join(
        f"<tr><td>{esc(REASON_NAMES.get(k, k))}</td><td class='n'>{v}</td>"
        f"<td><div class='bar warn' style='width:{int(100 * v / top)}%'></div></td></tr>"
        for k, v in reasons.most_common()) or "<tr><td class='meta'>目前沒有倒讚原因</td></tr>"

    by_office = defaultdict(lambda: [0, 0])
    for f in feedback:
        by_office[f["office"]][0 if f["rating"] == "up" else 1] += 1
    office_rows = "".join(
        f"<tr><td>{esc(office_label(k))}</td><td class='n'>{u}</td><td class='n'>{d}</td>"
        f"<td class='n'>{100 * u / (u + d):.0f}%</td></tr>"
        for k, (u, d) in sorted(by_office.items(), key=lambda kv: -sum(kv[1])))

    by_day = defaultdict(lambda: [0, 0])
    for f in feedback:
        by_day[f["ts"][:10]][0 if f["rating"] == "up" else 1] += 1
    day_rows = "".join(f"<tr><td>{esc(d)}</td><td class='n'>{u}</td><td class='n'>{n}</td></tr>"
                       for d, (u, n) in sorted(by_day.items(), reverse=True))

    attention = [f for f in feedback if f["rating"] == "down" or f["comment"]]
    generated = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>使用者回饋</title>
<style>
:root{{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#0969da;--warn:#bf3989;--card:#f6f8fa}}
@media (prefers-color-scheme: dark){{:root{{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#4493f8;--warn:#db61a2;--card:#161b22}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif;padding:24px 16px;max-width:1000px;margin:auto}}
h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:18px;margin:28px 0 8px}}
.sub,.meta{{color:var(--muted);font-size:13px}} .cards{{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:110px}}
.card b{{display:block;font-size:22px}} table{{border-collapse:collapse;width:100%}} td,th{{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left}}
td.n,th.n{{text-align:right;width:70px}} .bar{{height:10px;background:var(--accent);border-radius:4px}} .bar.warn{{background:var(--warn)}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:24px}} @media (max-width:700px){{.grid{{grid-template-columns:1fr}}}}
details{{border:1px solid var(--line);border-radius:6px;margin:6px 0;padding:6px 10px}} summary{{cursor:pointer}}
.flag{{display:inline-block;margin-left:6px;padding:0 6px;border-radius:10px;font-size:12px;color:var(--warn);border:1px solid var(--warn)}}
.comment{{background:var(--card);border-left:3px solid var(--warn);padding:6px 10px}} .d p{{margin:4px 0}} .d ul{{margin:2px 0 6px 18px;padding:0}} .quote{{color:var(--muted)}}
</style></head><body>
<h1>使用者回饋</h1>
<p class="sub">最近 {days} 天（{generated} 產生）。資料來源：查詢紀錄 D1 {DB}；提問寫入前已遮罩個資。本報表只存於本機。</p>
<div class="cards">{''.join(f"<div class='card'>{esc(t)}<b>{esc(n)}</b></div>" for t, n in cards)}</div>
<div class="grid">
<div><h2>倒讚原因</h2><table>{reason_rows}</table></div>
<div><h2>每日回饋</h2><table><tr><th>日期</th><th class='n'>👍</th><th class='n'>👎</th></tr>{day_rows}</table></div>
</div>
<h2>各單位</h2><table><tr><th>單位</th><th class='n'>👍</th><th class='n'>👎</th><th class='n'>滿意度</th></tr>{office_rows}</table>
<h2>需要看的回饋｜{len(attention)} 筆</h2>
<p class="sub">倒讚與有文字意見的回饋；點開看提問、歸類、引用來源與回答。</p>
{''.join(item(f) for f in attention) or '<p class="sub">沒有</p>'}
<h2>全部回饋｜{total} 筆</h2>
{''.join(item(f) for f in feedback) or '<p class="sub">沒有</p>'}
</body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--out", default=os.path.join(ROOT, "evaluate", "results", "feedback_report.html"))
    ap.add_argument("--open", action="store_true")
    opts = ap.parse_args()
    since = (datetime.now(timezone.utc) - timedelta(days=opts.days)).strftime("%Y-%m-%dT%H:%M:%S")
    feedback, answer_count = build(load(since))
    os.makedirs(os.path.dirname(opts.out), exist_ok=True)
    with open(opts.out, "w", encoding="utf-8") as fh:
        fh.write(render(feedback, answer_count, opts.days))
    up = sum(1 for f in feedback if f["rating"] == "up")
    print(f"{len(feedback)} 筆回饋（👍 {up}、👎 {len(feedback) - up}），{answer_count} 則回答 → {opts.out}")
    if opts.open:
        webbrowser.open(f"file://{opts.out}")


if __name__ == "__main__":
    main()
