"""截圖案例回歸測試（老師建議 五-2）：中英文同義問法、人物查詢、未知人物、多輪追問與錯誤更正。

    # 先啟動本機後端（需要 config.txt 的 OPENAI_API_KEY 與本機索引）
    MCP_REGULATIONS=1 uvicorn agentic_v2_5_4high:app --port 8792
    python evaluate/regression_cases.py [--api http://127.0.0.1:8792] [--only P11,P13]

判斷分兩層，都通過才算通過：
1. 固定規則：必須出現／不得出現的字、是否被擋、回答語言（明確事實，結果可重現）。
2. 模型評分：依每題的「期望行為」判斷回答是否符合、引用是否支持結論、有沒有偏題或猜測
   （規則只能比對寫好的字，模型換個說法就抓不到；2026-10-09 P11 規則通過、實際卻把宋明謙說成校長）。
   評分模型用 config.txt 的 CLASSIFIER_MODEL（例如 Sonnet 5.5），沒有設定時用 MODEL_BIG。
驗收要求：答案一致、引用支持結論、查不到不猜測、追問不偏題。
"""
import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def post(api, payload):
    out = subprocess.run(
        ["curl", "-s", "-m", "240", "-X", "POST", f"{api}/api/chat", "-H", "content-type: application/json",
         "-d", json.dumps(payload)],
        capture_output=True, text=True,
    ).stdout
    try:
        return json.loads(out)
    except ValueError:
        return {"status": "error", "answer": out[:200]}


JUDGE = """你是嚴格的驗收人員。依「期望行為」判斷「系統回答」是否合格。
重點：答案是否正確且與期望一致、引用的來源是否直接支持答案、查不到時有沒有明說而不猜測、追問時有沒有偏離本輪問題（例如把問 A 改答成 B）。
注意：系統的設計是「回答內文已附來源連結時，來源清單不重複列出」，所以來源清單是空的不代表沒有引用；請以回答內文中的來源名稱與連結判斷。
只要有一項不符合期望就判不合格。只輸出 JSON：{"pass": true|false, "reason": "一句話"}"""


def judge(case, answer, sources):
    sys.path.insert(0, ROOT)
    os.environ.setdefault("NTPU_SKIP_INDEX_BUILD", "1")
    import llm_adapter
    msgs = [{"role": "system", "content": JUDGE}, {"role": "user", "content": (
        f"對話（依序）：{' → '.join(case['turns'])}\n"
        + (f"（第一輪系統曾回答：{case['prior_answer']}）\n" if case.get("prior_answer") else "")
        + f"期望行為：{case['expect']}\n系統最後一輪回答：{answer[:3000]}\n系統列出的來源：{json.dumps(sources, ensure_ascii=False)[:1500]}")}]
    try:
        if llm_adapter.classifier_client is not None:
            rsp = llm_adapter.classifier_client.chat.completions.create(
                model=llm_adapter.CLASSIFIER_MODEL, messages=msgs, temperature=0, max_tokens=800,
                response_format={"type": "json_object"})
            raw = rsp.choices[0].message.content or ""
        else:
            raw = ""
        if not raw.strip():  # 評分模型偶爾回傳空白：改用 MODEL_BIG 重評，不直接判失敗
            raw = llm_adapter.complete(msgs, model=llm_adapter.MODEL_BIG, response_format={"type": "json_object"})
        m = re.search(r"\{.*\}", raw, re.S)
        return json.loads(m.group(0)) if m else {"pass": False, "reason": f"評分輸出無法解析：{raw[:60]}"}
    except Exception as e:  # 評分失敗不當作通過
        return {"pass": False, "reason": f"評分失敗：{type(e).__name__}"}


def language_of(text):
    cjk = len(re.findall(r"[一-鿿]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    return "en" if latin > cjk * 2 else "zh"


def run_case(api, case):
    history, state, last = [], {}, {}
    for i, question in enumerate(case["turns"]):
        last = post(api, {"question": question, "history": history, "conversation_state": state})
        answer = last.get("answer") or last.get("message") or ""
        if i == 0 and case.get("prior_answer"):
            answer = case["prior_answer"]  # 模擬上一輪的錯誤回答（測試主動更正）
        history += [{"role": "user", "content": question}, {"role": "assistant", "content": answer}]
        state = last.get("conversation_state") or state
    answer = last.get("answer") or last.get("message") or ""
    failures = []
    for group in case.get("must_include", []):
        if not any(term in answer for term in group):
            failures.append(f"缺少：{'／'.join(group)}")
    for term in case.get("must_exclude", []):
        if term in answer:
            failures.append(f"不該出現：{term}")
    if case.get("status") and last.get("status") != case["status"]:
        failures.append(f"狀態應為 {case['status']}，實際 {last.get('status')}")
    if case.get("language") and last.get("status") == "ok" and language_of(answer) != case["language"]:
        failures.append(f"語言應為 {case['language']}")
    soft = [g for g in case.get("soft_include", []) if not any(t in answer for t in g)]
    verdict = judge(case, answer, last.get("sources") or []) if case.get("expect") else {"pass": True, "reason": ""}
    if not verdict.get("pass"):
        failures.append(f"評分不合格：{verdict.get('reason', '')}")
    return {"id": case["id"], "group": case["group"], "turns": case["turns"], "status": last.get("status"),
            "domain": last.get("domain"), "answer": answer, "failures": failures,
            "soft_missing": ["／".join(g) for g in soft]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8792")
    ap.add_argument("--only", default="", help="只跑這些 id，逗號分隔")
    opts = ap.parse_args()
    spec = json.load(open(os.path.join(ROOT, "evaluate", "regression_cases.json"), encoding="utf-8"))
    cases = [c for c in spec["cases"] if not opts.only or c["id"] in opts.only.split(",")]
    rows = [run_case(opts.api, c) for c in cases]
    for r in rows:
        mark = "✓" if not r["failures"] else "✗"
        print(f"{mark} {r['id']} [{r['group']}] {' → '.join(r['turns'])}　({r['status']}/{r['domain']})")
        for f in r["failures"]:
            print(f"     {f}")
        if r["soft_missing"]:
            print(f"     （建議項目未達成：{', '.join(r['soft_missing'])}）")
        if r["failures"]:
            print(f"     回答：{r['answer'][:200].replace(chr(10), ' ')}")
    passed = sum(1 for r in rows if not r["failures"])
    print(f"\n通過 {passed}/{len(rows)}")
    os.makedirs(os.path.join(ROOT, "evaluate", "results"), exist_ok=True)
    json.dump(rows, open(os.path.join(ROOT, "evaluate", "results", "regression_cases.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    sys.exit(0 if passed == len(rows) else 1)


if __name__ == "__main__":
    main()
