"""處室歸類總覽：從查詢紀錄（D1 ntpu-aia-query-logs）產生本機 HTML 報表。

    python evaluate/routing_report.py                 # 最近 7 天 → evaluate/results/routing_report.html
    python evaluate/routing_report.py --days 30
    python evaluate/routing_report.py --open          # 產生後用瀏覽器開啟

報表只存在本機（evaluate/results/ 不進 git）：紀錄裡有使用者的提問（寫入前已遮罩電話、Email、身分證號），
不放到任何線上服務。內容：
- 各單位被問了幾題、各單位的問題清單；
- 需要注意：被擋下、反問、判斷信心偏低（< 0.7）、回答改成「無法確認」、證據不足；
- 點開任一題看完整流程：改寫後的問題、歸類原因、工具呼叫、引用來源、回答開頭。
"""
import argparse
import html
import json
import os
import subprocess
import sys
import webbrowser
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("NTPU_SKIP_INDEX_BUILD", "1")

from conversation_guardrail import OFFICE_NAMES  # noqa: E402

DB = "ntpu-aia-query-logs"
PAGE = 500
LOW_CONFIDENCE = 0.7


def query(sql: str) -> list:
    """透過 wrangler 讀 D1（唯讀查詢）。"""
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        cwd=os.path.join(ROOT, "cf"), capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise SystemExit(f"讀取 D1 失敗：{out.stderr.strip()[-300:]}")
    return json.loads(out.stdout)[0]["results"]


def load_events(since_iso: str) -> list:
    rows, last_id = [], 0
    while True:
        batch = query(
            "SELECT id, event, payload_json FROM query_events "
            f"WHERE id > {last_id} AND ts >= '{since_iso}' AND event IN ('guardrail','answer','rewrite_check') "
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


def office_label(code) -> str:
    if not code:
        return "未指定（跨單位）"
    code = str(code).lower()
    return f"{OFFICE_NAMES.get(code, code)}（{code}）"


def build_questions(events: list) -> list:
    """以範圍判斷（guardrail）事件為主列出每一題，再接上同一對話、同一問題之後的回答事件。"""
    answers = defaultdict(list)
    for e in events:
        if e.get("event") == "answer":
            answers[(e.get("conversation_id"), e.get("raw_query"))].append(e)
    rewrites = {(e.get("conversation_id"), e.get("raw_query")): e for e in events if e.get("event") == "rewrite_check"}
    questions = []
    for g in (e for e in events if e.get("event") == "guardrail"):
        key = (g.get("conversation_id"), g.get("raw_query"))
        ans = next((a for a in answers.get(key, []) if a.get("ts", "") >= g.get("ts", "")), None)
        result = g.get("result") or ""
        office = (ans or {}).get("selected_office") or g.get("selected_office") or (g.get("route_final") or "").lower() or None
        if office in ("other", "system"):
            office = None
        answer_text = (ans or {}).get("answer") or ""
        check = (ans or {}).get("answer_check") or {}
        flags = []
        if result in ("OUT_OF_SCOPE", "EXTERNAL_ENTITY_BLOCKED"):
            flags.append("被擋下")
        if result == "AMBIGUOUS":
            flags.append("反問")
        conf = g.get("scope_confidence")
        if isinstance(conf, (int, float)) and conf < LOW_CONFIDENCE and result not in ("OUT_OF_SCOPE",):
            flags.append(f"信心偏低 {conf:.2f}")
        if "無法確認" in answer_text[:60] or "can't confirm" in answer_text[:80]:
            flags.append("改成無法確認")
        if ans and ans.get("evidence_sufficient") is False:
            flags.append("證據不足")
        if key in rewrites:
            flags.append("改寫被修正")
        questions.append({
            "ts": g.get("ts", ""), "raw": g.get("raw_query") or "", "standalone": g.get("standalone_query") or "",
            "result": result, "office": office, "confidence": conf, "followup": g.get("is_followup"),
            "reason": (ans or {}).get("scope_reason") or "", "tools": (ans or {}).get("tool_calls") or [],
            "sources": (ans or {}).get("sources") or [], "answer": answer_text, "check": check,
            "latency": (ans or {}).get("latency_s"), "message_id": (ans or {}).get("message_id") or "", "flags": flags,
        })
    return questions


def esc(v) -> str:
    return html.escape(str(v if v is not None else ""))


def detail(q: dict) -> str:
    tools = "".join(f"<li>{esc(t.get('name'))} {esc(json.dumps(t.get('args'), ensure_ascii=False))}</li>" for t in q["tools"])
    sources = "".join(
        f"<li>{esc(s.get('unit', ''))}{'｜' if s.get('unit') else ''}{esc(s.get('title'))}"
        + (f"<br><span class='quote'>「{esc(s.get('quote'))}」</span>" if s.get("quote") else "") + "</li>"
        for s in q["sources"])
    check = q["check"]
    check_line = (f"<p><b>證據檢查</b>：{'通過' if check.get('supported', True) and not check.get('conflict') else '不通過'}"
                  f"{('（' + esc(check.get('reason')) + '）') if check.get('reason') else ''}</p>") if check else ""
    return (
        f"<p><b>改寫後</b>：{esc(q['standalone'])}</p>"
        f"<p><b>歸類</b>：{esc(office_label(q['office']))}｜結果 {esc(q['result'])}｜信心 {esc(q['confidence'])}"
        f"{'｜追問' if q['followup'] else ''}</p>"
        + (f"<p><b>歸類原因</b>：{esc(q['reason'])}</p>" if q["reason"] else "")
        + (f"<p><b>工具呼叫</b></p><ul>{tools}</ul>" if tools else "")
        + (f"<p><b>引用來源</b></p><ul>{sources}</ul>" if sources else "")
        + check_line
        + (f"<p><b>回答</b>：{esc(q['answer'][:400])}{'…' if len(q['answer']) > 400 else ''}</p>" if q["answer"] else "")
        + f"<p class='meta'>{esc(q['ts'])}{('｜' + esc(q['latency']) + ' 秒') if q['latency'] else ''}"
        + (f"｜message_id {esc(q['message_id'])}" if q["message_id"] else "") + "</p>"
    )


def row(q: dict) -> str:
    flags = "".join(f"<span class='flag'>{esc(f)}</span>" for f in q["flags"])
    return f"<details><summary><span class='q'>{esc(q['raw'])}</span>{flags}</summary><div class='d'>{detail(q)}</div></details>"


def render(questions: list, days: int) -> str:
    by_office = defaultdict(list)
    for q in questions:
        by_office[q["office"]].append(q)
    counts = Counter({k: len(v) for k, v in by_office.items()})
    total = len(questions)
    flagged = [q for q in questions if q["flags"]]
    cards = [("總題數", total), ("已回答", sum(1 for q in questions if q["answer"])),
             ("被擋下", sum(1 for q in questions if "被擋下" in q["flags"])),
             ("反問", sum(1 for q in questions if "反問" in q["flags"])),
             ("需要注意", len(flagged))]
    top = max(counts.values() or [1])
    bars = "".join(
        f"<tr><td><a href='#o-{esc(k or 'none')}'>{esc(office_label(k))}</a></td><td class='n'>{v}</td>"
        f"<td><div class='bar' style='width:{int(100 * v / top)}%'></div></td></tr>"
        for k, v in counts.most_common())
    sections = "".join(
        f"<h3 id='o-{esc(k or 'none')}'>{esc(office_label(k))}｜{len(v)} 題</h3>"
        + "".join(row(q) for q in sorted(v, key=lambda q: q["ts"], reverse=True))
        for k, v in sorted(by_office.items(), key=lambda kv: -len(kv[1])))
    generated = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>處室歸類總覽</title>
<style>
:root{{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#0969da;--warn:#bf3989;--card:#f6f8fa}}
@media (prefers-color-scheme: dark){{:root{{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#4493f8;--warn:#db61a2;--card:#161b22}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif;margin:0;padding:24px 16px;max-width:1000px;margin:auto}}
h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:18px;margin:28px 0 8px}} h3{{font-size:16px;margin:22px 0 6px}}
.sub,.meta{{color:var(--muted);font-size:13px}} .cards{{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:110px}}
.card b{{display:block;font-size:22px}} table{{border-collapse:collapse;width:100%}} td{{padding:4px 6px;border-bottom:1px solid var(--line)}}
td.n{{text-align:right;width:48px}} .bar{{height:10px;background:var(--accent);border-radius:4px}} a{{color:var(--accent)}}
details{{border:1px solid var(--line);border-radius:6px;margin:6px 0;padding:6px 10px}} summary{{cursor:pointer}}
.flag{{display:inline-block;margin-left:6px;padding:0 6px;border-radius:10px;font-size:12px;color:var(--warn);border:1px solid var(--warn)}}
.d p{{margin:4px 0}} .d ul{{margin:2px 0 6px 18px;padding:0}} .quote{{color:var(--muted)}}
</style></head><body>
<h1>處室歸類總覽</h1>
<p class="sub">最近 {days} 天（{generated} 產生）。資料來源：查詢紀錄 D1 {DB}；提問寫入前已遮罩個資。本報表只存於本機。</p>
<div class="cards">{''.join(f"<div class='card'>{esc(t)}<b>{n}</b></div>" for t, n in cards)}</div>
<h2>各單位題數</h2><table>{bars}</table>
<h2>需要注意｜{len(flagged)} 題</h2>
<p class="sub">被擋下、反問、判斷信心低於 {LOW_CONFIDENCE}、回答改成「無法確認」、證據不足、改寫被修正。</p>
{''.join(row(q) for q in sorted(flagged, key=lambda q: q["ts"], reverse=True)) or '<p class="sub">沒有</p>'}
<h2>各單位的問題</h2>{sections}
</body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", default=os.path.join(ROOT, "evaluate", "results", "routing_report.html"))
    ap.add_argument("--open", action="store_true")
    opts = ap.parse_args()
    since = (datetime.now(timezone.utc) - timedelta(days=opts.days)).strftime("%Y-%m-%dT%H:%M:%S")
    questions = build_questions(load_events(since))
    os.makedirs(os.path.dirname(opts.out), exist_ok=True)
    with open(opts.out, "w", encoding="utf-8") as fh:
        fh.write(render(questions, opts.days))
    counts = Counter(office_label(q["office"]) for q in questions)
    print(f"{len(questions)} 題 → {opts.out}")
    for name, n in counts.most_common():
        print(f"  {n:4} {name}")
    if opts.open:
        webbrowser.open(f"file://{opts.out}")


if __name__ == "__main__":
    main()
