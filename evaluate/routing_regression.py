"""處室歸類回歸測試：每個單位幾題代表性問題（含容易混淆的），確認範圍判斷與處室歸類沒有分錯。

    python evaluate/routing_regression.py                 # 跑 evaluate/routing_cases.json 全部
    python evaluate/routing_regression.py --only R44,R45
    python evaluate/routing_regression.py --repeat 3      # 每題跑 3 次，看歸類穩不穩定

只跑 prepare_conversation_turn（改寫、範圍判斷、處室歸類），不產生回答，所以比完整回歸快。
需要 config.txt 的金鑰與本機索引（人名比對會用到）。新增單位或修改歸類邏輯後都要跑一次。
"""
import argparse
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("MCP_REGULATIONS", "1")

import agentic_v2_5_4high as core  # noqa: E402


def classify(question: str):
    """回傳 (歸類, 狀態)：歸類是處室代碼、None（跨單位）或 "blocked"。"""
    decision = core.prepare_conversation_turn(question, [])
    status = decision.get("status")
    if status == "blocked":
        return "blocked", status
    return decision.get("office"), status


def label(v) -> str:
    if v is None:
        return "跨單位"
    if v == "blocked":
        return "擋下"
    return f"{core.DEPT_NAMES.get(v, v)}({v})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--repeat", type=int, default=1)
    opts = ap.parse_args()
    spec = json.load(open(os.path.join(ROOT, "evaluate", "routing_cases.json"), encoding="utf-8"))
    cases = [c for c in spec["cases"] if not opts.only or c["id"] in opts.only.split(",")]
    rows, failed = [], 0
    for c in cases:
        results = [classify(c["question"]) for _ in range(opts.repeat)]
        got = [r[0] for r in results]
        ok = all(g in c["accept"] for g in got)
        failed += not ok
        statuses = Counter(r[1] for r in results)
        mark = "✓" if ok else "✗"
        print(f"{mark} {c['id']} {c['question']}　→ {'、'.join(label(g) for g in got)}"
              + ("" if ok else f"　（應為 {'／'.join(label(a) for a in c['accept'])}）")
              + (f"　{dict(statuses)}" if any(s == "clarification" for s in statuses) else ""))
        rows.append({**c, "got": got, "statuses": dict(statuses), "pass": ok})
    print(f"\n通過 {len(cases) - failed}/{len(cases)}")
    os.makedirs(os.path.join(ROOT, "evaluate", "results"), exist_ok=True)
    json.dump(rows, open(os.path.join(ROOT, "evaluate", "results", "routing_regression.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
