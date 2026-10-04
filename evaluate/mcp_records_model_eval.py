"""法規／常見問答端到端評估（規格 10 §10，model-in-loop）：
同一批題目分別問「開關關閉（舊路線）」與「開關開啟（MCP）」的本機後端，由模型對照參考答案評分。

    # 先啟動兩個本機後端（需要 config.txt 的 OPENAI_API_KEY 與本機索引）
    MCP_REGULATIONS=0 uvicorn agentic_v2_5_4high:app --port 8791
    MCP_REGULATIONS=1 uvicorn agentic_v2_5_4high:app --port 8792
    python evaluate/mcp_records_model_eval.py

參考答案：從 MCP 取 golden set 每題 expect 指向的那筆 FAQ／法規全文（expect 為 null 的題目應回答查無）。
評分：答案是否與參考答案一致、沒有編造；另外記錄 MCP 路線是否真的用了 MCP（data_updated_at）。
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

import agentic_v2_5_4high  # noqa: E402,F401  載入 config.txt
import llm_adapter  # noqa: E402
import mcp_client  # noqa: E402

PORTS = {"local": 8791, "mcp": 8792}


def reference(case):
    if case["expect"] is None:
        return None
    reg_unit, faq_unit = mcp_client.DEPT_TO_MCP_RECORD_UNITS[case["dept"]]
    for kind, tool, get, field, unit in (
        ("faq", "search_faqs", "get_faq", "faq", faq_unit),
        ("regulation", "search_regulations", "get_regulation", "regulation", reg_unit),
    ):
        if not unit:
            continue
        # 用前 12 個字查：正式 MCP 修正前，17 個中文字以上的關鍵字會超過 D1 的 LIKE 長度上限。
        items = mcp_client.call_tool(tool, {"keyword": case["expect"][:12], "unit": unit, "limit": 20})["items"]
        for item in items:
            heading = item.get("question") or item.get("title") or ""
            if case["expect"] in heading:
                rec = mcp_client.call_tool(get, {"id": item["id"]})[field] or {}
                body = rec.get("answer") or rec.get("bodyText") or item.get("snippet", "")
                return f"{heading}\n{body}"[:3000]
    return None


def ask(port, question):
    t = time.time()
    out = subprocess.run(
        ["curl", "-s", "-m", "240", "-X", "POST", f"http://127.0.0.1:{port}/api/chat",
         "-H", "content-type: application/json", "-d", json.dumps({"question": question})],
        capture_output=True, text=True,
    ).stdout
    try:
        d = json.loads(out)
    except ValueError:
        d = {"status": "error", "answer": out[:200]}
    d["_seconds"] = round(time.time() - t, 1)
    return d


GRADER = """你是評分員。根據「參考資料」判斷「系統回答」是否正確回答了「使用者問題」。
- 參考資料不是 null：回答的重點須與參考資料一致，且沒有與參考資料矛盾或明顯編造的內容，才算 correct=true。
  回答比參考資料多出合理的一般性建議（例如請洽承辦單位）不扣分。
- 參考資料是 null：系統應表示查無資料或建議洽詢，沒有編造具體規定，才算 correct=true。
只輸出 JSON：{"correct": true|false, "reason": "一句話"}"""


def grade(question, ref, answer):
    raw = llm_adapter.complete(
        [{"role": "system", "content": GRADER},
         {"role": "user", "content": f"使用者問題：{question}\n\n參考資料：{ref if ref else 'null'}\n\n系統回答：{answer[:3000]}"}],
        model=llm_adapter.MODEL_BIG, response_format={"type": "json_object"},
    )
    try:
        return json.loads(raw)
    except ValueError:
        return {"correct": False, "reason": f"grader 輸出無法解析：{raw[:60]}"}


def main():
    golden = json.load(open(os.path.join(ROOT, "evaluate", "mcp_records_golden.json"), encoding="utf-8"))
    cases = golden["cases"]
    refs = [reference(c) for c in cases]
    missing = [c["id"] for c, r in zip(cases, refs) if c["expect"] and not r]
    if missing:
        print(f"找不到參考資料（不計分）：{missing}")

    def run(i):
        c = cases[i]
        row = {"id": c["id"], "question": c["question"]}
        for mode, port in PORTS.items():
            d = ask(port, c["question"])
            answer = d.get("answer") or d.get("message") or ""
            row[mode] = {
                "status": d.get("status"), "seconds": d["_seconds"],
                "used_mcp": bool(d.get("data_updated_at")),
                "grade": grade(c["question"], refs[i], answer),
                "answer": answer[:400],
            }
        return row

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(run, [i for i, c in enumerate(cases) if c["id"] not in missing]))

    os.makedirs(os.path.join(ROOT, "evaluate", "results"), exist_ok=True)
    out = os.path.join(ROOT, "evaluate", "results", "mcp_records_model_eval.json")
    json.dump(rows, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    n = len(rows)
    for r in rows:
        marks = " ".join(f"{m}:{'✓' if r[m]['grade'].get('correct') else '✗'}" for m in PORTS)
        print(f"{r['id']} {marks} mcp用到MCP={'是' if r['mcp']['used_mcp'] else '否'} {r['question']}")
        for m in PORTS:
            if not r[m]["grade"].get("correct"):
                print(f"    {m}✗ {r[m]['grade'].get('reason', '')}")
    for m in PORTS:
        ok = sum(bool(r[m]["grade"].get("correct")) for r in rows)
        secs = sorted(r[m]["seconds"] for r in rows)
        print(f"{m}: {ok}/{n} ({ok / n:.0%})  回應時間中位數 {secs[n // 2]}s")
    print(f"MCP 路線實際用到 MCP：{sum(r['mcp']['used_mcp'] for r in rows)}/{n}")
    print(f"明細：{out}")


if __name__ == "__main__":
    main()
