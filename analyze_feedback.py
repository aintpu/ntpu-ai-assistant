# -*- coding: utf-8 -*-
"""回饋與使用狀況分析

把 answer 與 feedback 兩種事件以 message_id 配對，輸出滿意率、負評原因分布、
各處室表現與具體的負評案例。

用法：
    # 本機（讀 events.jsonl）
    python analyze_feedback.py

    # 指定檔案
    python analyze_feedback.py path/to/events.jsonl

    # GCP：先把 Cloud Logging 的事件抓下來再分析
    gcloud logging read 'jsonPayload.event="answer" OR jsonPayload.event="feedback"' \
        --limit 5000 --format="value(jsonPayload)" > cloud_events.jsonl
    python analyze_feedback.py cloud_events.jsonl
"""
import json
import os
import sys
from collections import Counter, defaultdict

REASON_LABELS = {
    "wrong_info": "資訊錯誤，與實際規定不符",
    "outdated":   "資訊過時",
    "off_topic":  "答非所問",
    "too_vague":  "太籠統，不夠具體",
    "bad_source": "找不到出處或連結有誤",
    "other":      "其他",
}
DEPT_LABELS = {
    "ope": "體育室", "ge": "通識教育中心", "lc": "語言中心",
    "oaa": "教務處", "osa": "學務處", "": "（閒聊／未分類）",
}


def load_events(path):
    answers, feedbacks = {}, []
    bad = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                bad += 1          # 非 JSON 的行（uvicorn 一般日誌）直接略過
                continue
            ev = d.get("event")
            if ev == "answer" and d.get("message_id"):
                answers[d["message_id"]] = d
            elif ev == "feedback":
                feedbacks.append(d)
    return answers, feedbacks, bad


def bar(n, total, width=28):
    if not total:
        return ""
    filled = round(width * n / total)
    return "█" * filled + "·" * (width - filled)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "events.jsonl")

    if not os.path.exists(path):
        print(f"找不到事件檔：{path}")
        print("本機需先與使用者互動產生 events.jsonl；GCP 請見本檔開頭的 gcloud 指令。")
        return 1

    answers, feedbacks, bad = load_events(path)
    print("=" * 62)
    print(f"事件來源：{path}")
    print(f"回答 {len(answers)} 筆 / 回饋 {len(feedbacks)} 筆"
          + (f"（略過 {bad} 行非 JSON）" if bad else ""))

    # ── 使用狀況 ──────────────────────────────────────────────
    sessions = {a.get("session_id") for a in answers.values() if a.get("session_id")}
    per_dept = Counter(a.get("dept", "") for a in answers.values())
    lat = [a["latency_s"] for a in answers.values() if isinstance(a.get("latency_s"), (int, float))]

    print("\n【使用狀況】")
    print(f"  不重複對話數（session）：{len(sessions)}")
    if sessions:
        print(f"  平均每個 session 提問數：{len(answers) / len(sessions):.1f}")
    if lat:
        lat_sorted = sorted(lat)
        p50 = lat_sorted[len(lat_sorted) // 2]
        p95 = lat_sorted[max(0, int(len(lat_sorted) * 0.95) - 1)]
        print(f"  回應時間：中位數 {p50:.1f}s／p95 {p95:.1f}s／最長 {max(lat):.1f}s")

    print("\n  各處室提問量：")
    for dept, n in per_dept.most_common():
        print(f"    {DEPT_LABELS.get(dept, dept):<14} {n:>4}  {bar(n, len(answers))}")

    if not feedbacks:
        print("\n【回饋】尚無資料。")
        print("=" * 62)
        return 0

    # ── 滿意率 ────────────────────────────────────────────────
    # 同一則回答重複送出時只計最後一次
    latest = {}
    for fb in feedbacks:
        latest[fb.get("message_id")] = fb
    ups = sum(1 for f in latest.values() if f.get("rating") == "up")
    downs = sum(1 for f in latest.values() if f.get("rating") == "down")
    total = ups + downs

    print("\n【回饋總覽】")
    print(f"  有效回饋：{total} 筆（去除同則重複評價）")
    if total:
        print(f"  滿意率：{ups / total * 100:.1f}%   👍 {ups} ／ 👎 {downs}")
    if answers:
        print(f"  回饋率：{total / len(answers) * 100:.1f}%（{total}／{len(answers)} 則回答）")

    # ── 負評原因 ──────────────────────────────────────────────
    reasons = Counter()
    for f in latest.values():
        for r in f.get("reasons", []):
            reasons[r] += 1
    if reasons:
        print("\n【負評原因分布】")
        for r, n in reasons.most_common():
            print(f"    {REASON_LABELS.get(r, r):<22} {n:>3}  {bar(n, downs)}")

    # ── 各處室滿意率（找出最該補資料的處室）────────────────────
    dept_stat = defaultdict(lambda: [0, 0])   # dept -> [up, down]
    for mid, f in latest.items():
        a = answers.get(mid)
        if not a:
            continue
        idx = 0 if f.get("rating") == "up" else 1
        dept_stat[a.get("dept", "")][idx] += 1
    if dept_stat:
        print("\n【各處室滿意率】")
        for dept, (u, d) in sorted(dept_stat.items(), key=lambda x: -(x[1][0] + x[1][1])):
            t = u + d
            print(f"    {DEPT_LABELS.get(dept, dept):<14} {u/t*100:>5.1f}%  （{u} 讚／{d} 倦）")

    # ── 負評案例 ──────────────────────────────────────────────
    cases = [(mid, f) for mid, f in latest.items() if f.get("rating") == "down"]
    if cases:
        print(f"\n【負評案例】共 {len(cases)} 筆，以下列出最近 10 筆")
        for mid, f in cases[-10:]:
            a = answers.get(mid, {})
            print("\n  " + "-" * 58)
            print(f"  問題：{a.get('question', '（對不到回答事件）')}")
            print(f"  處室：{DEPT_LABELS.get(a.get('dept', ''), a.get('dept', '?'))}"
                  f"　原因：{'、'.join(REASON_LABELS.get(r, r) for r in f.get('reasons', [])) or '未選'}")
            if f.get("comment"):
                print(f"  說明：{f['comment']}")
            ans = (a.get("answer") or "").replace("\n", " ")
            if ans:
                print(f"  當時回答：{ans[:120]}…")

    orphan = sum(1 for mid in latest if mid not in answers)
    if orphan:
        print(f"\n  註：{orphan} 筆回饋對不到回答事件"
              "（回答與回饋分屬不同時間範圍時會發生，擴大查詢區間即可）")

    print("\n" + "=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
