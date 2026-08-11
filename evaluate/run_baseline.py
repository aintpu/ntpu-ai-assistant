# -*- coding: utf-8 -*-
# run_baseline.py — 對現行 pipeline 跑全題庫（v3 OPE + v4 GE/LC），產出 baseline 成績單
# 用法：在 NTPUOPE_v2 目錄下執行  .venv\Scripts\python.exe -X utf8 -u evaluate\run_baseline.py [標籤] [--ope-only|--ge-lc-only]
# 輸出：evaluate/results/baseline_<標籤>.json（含逐題結果與各處室分項統計）

import os, sys, json, time, statistics
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(BASE)          # config.txt 與資料檔皆為相對路徑
sys.path.insert(0, BASE)

import agentic_v2_5_4high as core

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = [a for a in sys.argv[1:] if a.startswith("--")]
LABEL = args[0] if args else "gpt54mini_high_" + datetime.now().strftime("%Y%m%d")
OUT_PATH = os.path.join(BASE, "evaluate", "results", f"baseline_{LABEL}.json")
OPE_ONLY   = "--ope-only"   in flags
GE_LC_ONLY = "--ge-lc-only" in flags

# 題庫 expected_tool → 現行工具名稱
TOOL_MAP = {
    "tool_search_database": "search_regulations_and_general",
    "tool_get_grade": "get_competition_records",
    "tool_get_latest_news": "get_latest_news",
}

# 評分員固定用 OpenAI gpt-4o-mini（量尺不可隨 LLM_PROVIDER 改變，否則跨配置分數不可比）
from openai import OpenAI as _OpenAI
_judge_client = _OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
JUDGE_MODEL = "gpt-4o-mini"

def judge(question: str, ground_truth: str, answer: str) -> str:
    """LLM 評分：CORRECT / PARTIAL / WRONG"""
    p = ("你是評分員。比對「系統回答」與「標準答案」的事實內容是否一致，只回一個詞：\n"
         "CORRECT＝標準答案的關鍵事實（數字、名稱、時間、規定）都正確出現在回答中\n"
         "PARTIAL＝回答方向正確但關鍵事實不完整或部分模糊\n"
         "WRONG＝關鍵事實錯誤、答非所問、或回答「查無資料」\n\n"
         f"問題：{question}\n標準答案：{ground_truth}\n系統回答：{answer[:2000]}")
    try:
        rsp = _judge_client.chat.completions.create(
            model=JUDGE_MODEL, temperature=0, max_tokens=5,
            messages=[{"role": "user", "content": p}])
        v = rsp.choices[0].message.content.strip().upper()
        return v if v in ("CORRECT", "PARTIAL", "WRONG") else "WRONG"
    except Exception:
        return "JUDGE_ERROR"

def main():
    qs = []
    if not GE_LC_ONLY:
        v3 = json.load(open(os.path.join(BASE, "evaluate", "test_questions_v3.json"), encoding="utf-8"))
        qs.extend(v3)
        print(f"Loaded v3 (OPE): {len(v3)} questions")
    if not OPE_ONLY:
        v4 = json.load(open(os.path.join(BASE, "evaluate", "test_questions_v4.json"), encoding="utf-8"))
        qs.extend(v4)
        print(f"Loaded v4 (GE/LC): {len(v4)} questions")
    print(f"Total: {len(qs)} questions\n")

    results = []
    for i, q in enumerate(qs, 1):
        t0 = time.time()
        try:
            dept_code = q.get("dept") or core.classify_department(q["question"])
            dept_arg = None if dept_code in ("chat", "other", "inject") else dept_code
            answer = core.synthesize_agentic_answer(
                q["question"], "zh-TW", [], dept=dept_arg, injection_checked=True
            )
            status = "ok"
            dept = dept_code
        except Exception as e:
            answer, status, dept = f"[執行錯誤] {e}", "error", ""
        latency = time.time() - t0

        called_tools = [s[5:] for s, _ in core.get_last_timings() if s.startswith("tool:")]
        expected = TOOL_MAP.get(q.get("expected_tool", ""), "")
        tool_hit = expected in called_tools if expected else None

        verdict = judge(q["question"], q["ground_truth"], answer) if status == "ok" else "WRONG"
        wrong_subtype = _wrong_subtype(answer, verdict)

        results.append({
            "id": q["id"], "question": q["question"], "category": q.get("category", ""),
            "ground_truth": q["ground_truth"], "answer": answer,
            "status": status, "dept": dept, "verdict": verdict,
            "wrong_subtype": wrong_subtype,
            "expected_tool": expected, "called_tools": called_tools, "tool_hit": tool_hit,
            "latency_s": round(latency, 1),
        })
        print(f"[{i}/{len(qs)}] {q['id']} {verdict} {latency:.0f}s tool_hit={tool_hit} | {q['question'][:30]}")

        if i % 10 == 0 or i == len(qs):
            _save(results, qs)

    _save(results, qs, final=True)

_NO_DATA_KW = ("查無", "查不到", "找不到", "無法確認", "沒有找到", "目前無法", "查詢不到", "尚無", "沒有查到", "無相關資料")

def _wrong_subtype(answer: str, verdict: str) -> str:
    """將 WRONG 細分：no_data（系統說查無）/ wrong_fact（給了錯誤事實）/ n/a（非WRONG）"""
    if verdict != "WRONG":
        return "n/a"
    if any(kw in answer for kw in _NO_DATA_KW):
        return "no_data"
    return "wrong_fact"

def _dept_stats(results, dept):
    dr = [r for r in results if r.get("dept") == dept]
    if not dr:
        return None
    ok = sum(1 for r in dr if r["verdict"] == "CORRECT")
    pa = sum(1 for r in dr if r["verdict"] == "PARTIAL")
    wr = [r for r in dr if r["verdict"] == "WRONG"]
    n = len(dr)
    return {"n": n, "correct": ok, "partial": pa, "wrong": len(wr),
            "wrong_no_data": sum(1 for r in wr if r.get("wrong_subtype") == "no_data"),
            "wrong_fact": sum(1 for r in wr if r.get("wrong_subtype") == "wrong_fact"),
            "accuracy_strict": round(ok / n, 3),
            "accuracy_with_partial": round((ok + 0.5 * pa) / n, 3)}

def _save(results, qs, final=False):
    n = len(results)
    ok = [r for r in results if r["verdict"] == "CORRECT"]
    pa = [r for r in results if r["verdict"] == "PARTIAL"]
    wr = [r for r in results if r["verdict"] == "WRONG"]
    tool_evald = [r for r in results if r["tool_hit"] is not None]
    lats = [r["latency_s"] for r in results]
    summary = {
        "label": LABEL, "model": core.MODEL_AGENT, "reasoning_effort": core.REASONING_EFFORT,
        "provider": core.llm_adapter.PROVIDER,
        "done": n, "total": len(qs),
        "correct": len(ok), "partial": len(pa), "wrong": len(wr),
        "wrong_no_data": sum(1 for r in wr if r.get("wrong_subtype") == "no_data"),
        "wrong_fact": sum(1 for r in wr if r.get("wrong_subtype") == "wrong_fact"),
        "accuracy_strict": round(len(ok) / n, 3) if n else 0,
        "accuracy_with_partial": round((len(ok) + 0.5 * len(pa)) / n, 3) if n else 0,
        "tool_accuracy": round(sum(1 for r in tool_evald if r["tool_hit"]) / len(tool_evald), 3) if tool_evald else None,
        "blocked_count": sum(1 for r in results if r["status"] == "blocked"),
        "latency_avg_s": round(sum(lats) / n, 1) if n else 0,
        "latency_median_s": round(statistics.median(lats), 1) if n else 0,
        "by_dept": {d: _dept_stats(results, d) for d in ("ope", "ge", "lc")
                    if _dept_stats(results, d)},
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }
    json.dump({"summary": summary, "results": results},
              open(OUT_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if final:
        print("\n===== BASELINE SUMMARY =====")
        print(json.dumps(summary, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
