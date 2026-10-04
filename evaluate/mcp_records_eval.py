"""法規／常見問答：MCP 路線 vs 本機索引路線的檢索比對。

    python evaluate/mcp_records_eval.py --mode mcp      # 只需網路，不需要 OpenAI 金鑰
    python evaluate/mcp_records_eval.py --mode local    # 需要 OPENAI_API_KEY 與本機索引
    python evaluate/mcp_records_eval.py --mode both

命中：回傳給模型的文件內容含 expect 片段；expect 為 null 的題目要「查無」才算對。
這是檢索層比對，不是模型選工具或最終答案品質；那部分要在開啟開關前另外用正式模型跑。
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["mcp", "local", "both"], default="mcp")
    opts = ap.parse_args()
    if opts.mode == "mcp":
        os.environ.setdefault("OPENAI_API_KEY", "not-used")
        os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"
    os.environ["MCP_REGULATIONS"] = "1"

    import agentic_v2_5_4high as core

    golden = json.load(open(os.path.join(ROOT, "evaluate", "mcp_records_golden.json"), encoding="utf-8"))
    modes = ["mcp", "local"] if opts.mode == "both" else [opts.mode]
    score = {m: 0 for m in modes}
    for case in golden["cases"]:
        row = [case["id"], case["dept"]]
        for mode in modes:
            core._reset_source_collector()
            if mode == "mcp":
                out = core._records_from_mcp(case["question"], case["keywords"], case["dept"]) or ""
            else:
                with_switch_off = dict(os.environ, MCP_REGULATIONS="0")
                os.environ.update(with_switch_off)
                out = core.tool_search_database(case["question"], dept=case["dept"])
                os.environ["MCP_REGULATIONS"] = "1"
                if "Evidence Check" in out or "沒有檢索到" in out:
                    out = ""
            ok = (not out) if case["expect"] is None else (case["expect"] in out)
            score[mode] += ok
            row.append(f"{mode}:{'✓' if ok else '✗'}")
        print(" ".join(row), case["question"])
    n = len(golden["cases"])
    for mode in modes:
        print(f"{mode}: {score[mode]}/{n} ({score[mode] / n:.0%})")


if __name__ == "__main__":
    main()
