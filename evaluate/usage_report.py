"""模型用量與費用統計：讀查詢紀錄（D1）裡每則回答的 llm_usage（2026-10-26 起記錄），在終端機列出。

    python3 evaluate/usage_report.py              # 最近 30 天
    python3 evaluate/usage_report.py --days 90

- 一般使用與評估（session_id 為 eval-…）分開統計。
- OpenRouter（Jev）的費用是回應附的實際金額；OpenAI 的費用要設定價格才算得出來：
  正式站環境變數 PRICE_GPT_6_LUNA="輸入,輸出"（每百萬 token 美元）。沒設定時本報表用 --luna-price 估算，
  或以 OpenAI 後台的月帳單對照 token 數校正。
- 2026-10-26 以前的回答沒有 llm_usage，不在統計內（之前的費用請看 OpenAI、OpenRouter 後台）。
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "evaluate"))
from routing_report import PAGE, query  # noqa: E402


def load(since):
    rows, last = [], 0
    while True:
        batch = query("SELECT id, ts, json_extract(payload_json,'$.session_id') s, json_extract(payload_json,'$.llm_usage') u "
                      f"FROM query_events WHERE id > {last} AND event='answer' AND ts >= '{since}' ORDER BY id LIMIT {PAGE}")
        rows += batch
        if len(batch) < PAGE:
            return rows
        last = batch[-1]["id"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--luna-price", default="", help="GPT-6 Luna 每百萬 token 美元「輸入,輸出」，例如 1.25,10（未設定則不估 OpenAI 費用）")
    opts = ap.parse_args()
    price = tuple(float(x) for x in opts.luna_price.split(",")) if opts.luna_price else None
    since = (datetime.now(timezone.utc) - timedelta(days=opts.days)).strftime("%Y-%m-%dT%H:%M:%S")
    stats = defaultdict(lambda: defaultdict(lambda: {"answers": 0, "calls": 0, "in": 0, "out": 0, "cost": 0.0, "est": 0.0}))
    no_usage = 0
    for r in load(since):
        if not r["u"]:
            no_usage += 1
            continue
        u = json.loads(r["u"])
        group = "評估" if (r["s"] or "").startswith("eval-") else "一般"
        day = r["ts"][:10]
        for key in (day, "合計"):
            s = stats[group][key]
            s["answers"] += 1
            s["calls"] += u.get("calls", 0)
            s["in"] += u.get("input_tokens", 0)
            s["out"] += u.get("output_tokens", 0)
            for model, m in (u.get("by_model") or {}).items():
                if m.get("cost_known"):
                    s["cost"] += m.get("cost_usd", 0)
                elif price and m.get("provider") == "openai":
                    s["est"] += (m["input_tokens"] * price[0] + m["output_tokens"] * price[1]) / 1_000_000
    print(f"最近 {opts.days} 天；沒有用量紀錄的回答（2026-10-26 以前）{no_usage} 則不計。")
    for group in ("一般", "評估"):
        if group not in stats:
            continue
        print(f"\n【{group}】")
        print(f"{'日期':<10} {'回答':>5} {'模型呼叫':>7} {'輸入 token':>12} {'輸出 token':>10} {'已知費用 US$':>12}"
              + (f" {'OpenAI 估算 US$':>15}" if price else ""))
        for day in sorted(k for k in stats[group] if k != "合計") + ["合計"]:
            s = stats[group][day]
            line = f"{day:<10} {s['answers']:>5} {s['calls']:>7} {s['in']:>12,} {s['out']:>10,} {s['cost']:>12.4f}"
            print(line + (f" {s['est']:>15.4f}" if price else ""))
        t = stats[group]["合計"]
        if t["answers"]:
            per = (t["cost"] + t["est"]) / t["answers"]
            print(f"平均每題：模型呼叫 {t['calls'] / t['answers']:.1f} 次、輸入 {t['in'] // t['answers']:,} token、"
                  f"費用約 US${per:.4f}" + ("" if price else "（僅含 OpenRouter 實際金額）"))


if __name__ == "__main__":
    main()
