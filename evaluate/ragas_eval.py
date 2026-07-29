# -*- coding: utf-8 -*-
"""
ragas_eval.py  -  完整評估版（6個指標 x 5個Judge模型）
指標：faithfulness / answer_relevancy / context_precision / context_recall
      / topic_adherence / tool_call_accuracy

執行：
    python evaluate/ragas_eval.py --judge gpt-oss
    python evaluate/ragas_eval.py --all
"""

import os, sys, json, argparse
import pandas as pd
from datetime import datetime
import numpy as np

config_path = "config.txt"
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                os.environ[k.strip()] = v.strip()

from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy, context_precision, context_recall
from datasets import Dataset
from langchain_community.chat_models import ChatOllama
from langchain_openai import OpenAIEmbeddings

RESULTS_DIR    = os.path.join(os.path.dirname(__file__), "results")
# QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions.json")
QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions_v2.json")
os.makedirs(RESULTS_DIR, exist_ok=True)

JUDGE_MODELS = {
    "gpt-oss":  "gpt-oss:20b",
    "gemma3":   "gemma3:27b",
    "nemotron": "nemotron-mini",
    "nemotron3nano":  "nemotron-3-nano:latest",
    "mistral":        "mistral:latest",
    "mistral-small":  "mistral-small:latest",
    "llama3":   "llama3.1:8b",
}

# ── Topic Adherence ───────────────────────────────────────────
REJECTION_PHRASES = [
    "無法回答", "不在服務範圍", "超出我的能力", "與體育室無關",
    "我只能協助", "非本系統服務", "out of scope",
    "cannot answer", "not relevant",
]

def compute_topic_adherence(results, questions_meta):
    rows = []
    for r in results:
        meta     = questions_meta.get(r.get("id",""), {})
        expected = meta.get("topic_adherent", True)
        answer   = r.get("answer","").lower()
        has_rej  = any(p.lower() in answer for p in REJECTION_PHRASES)
        if expected:
            score = 0.0 if (not answer or has_rej) else 1.0
        else:
            score = 1.0 if has_rej else 0.0
        rows.append({"question": r["question"], "topic_adherent": expected,
                     "has_rejection": has_rej, "topic_adherence": score})
    return pd.DataFrame(rows)

# ── Tool Call Accuracy ────────────────────────────────────────
TOOL_SIGNATURES = {
    "tool_get_grade": ["競賽成績紀錄","學年度","賽事名稱","競賽項目","名次","得獎者"],
    "tool_get_latest_news": ["最新消息","公告內容","發布日期","報名時間","比賽時間","附件內容"],
    "tool_get_schedule": ["課表","課程表","體育課程","上課時間","選課"],
    "tool_search_database": ["場地","聯絡","分機","訓練時間","教練","管理辦法","借用","代表隊"],
}

def infer_tool(contexts):
    combined = " ".join(contexts)
    scores   = {t: sum(1 for kw in kws if kw in combined)
                for t, kws in TOOL_SIGNATURES.items()}
    return max(scores, key=scores.get) if max(scores.values()) > 0 else "tool_search_database"

def compute_tool_call_accuracy(results, questions_meta):
    rows = []
    for r in results:
        meta     = questions_meta.get(r.get("id",""), {})
        expected = meta.get("expected_tool","")
        inferred = infer_tool(r.get("contexts",[]))
        correct  = 1.0 if inferred == expected else 0.0
        rows.append({"question": r["question"], "expected_tool": expected,
                     "inferred_tool": inferred, "tool_call_correct": correct})
    return pd.DataFrame(rows)

# ── 核心評估函數 ──────────────────────────────────────────────
def load_results(filename):
    path = os.path.join(RESULTS_DIR, filename)
    if not os.path.exists(path):
        print(f"[錯誤] 找不到 {path}，請先執行 collect_results.py"); return []
    with open(path, "r", encoding="utf-8") as f: return json.load(f)

def load_questions_meta():
    with open(QUESTIONS_PATH, "r", encoding="utf-8") as f:
        return {q["id"]: q for q in json.load(f)}

def build_ragas_dataset(results, questions_meta):
    data = {"question":[], "answer":[], "contexts":[], "ground_truth":[]}
    for r in results:
        if not r.get("answer") or not r.get("contexts"): continue
        gt = questions_meta.get(r.get("id",""), {}).get("ground_truth","")
        if not gt: continue
        data["question"].append(r["question"])
        data["answer"].append(r["answer"])
        data["contexts"].append(r["contexts"])
        data["ground_truth"].append(gt)
    print(f"  RAGAS 有效樣本：{len(data['question'])} 題")
    return Dataset.from_dict(data)

def run_ragas(dataset, system_name, judge_key):
    model_name = JUDGE_MODELS[judge_key]
    print(f"  [RAGAS] Judge={model_name} 評估中...")
    judge_llm = ChatOllama(
        model=model_name,
        temperature=0,
        num_predict=1024,     # 從 512 改成 1024
        # format="json",        # 強制 JSON 輸出
        timeout=120,
    )
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

    result = evaluate(
        dataset,
        metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
        llm=judge_llm,
        embeddings=embeddings,
    )
    detail           = result.to_pandas()
    detail["system"] = system_name
    detail["judge"]  = model_name
    scores = {}
    for k in ["faithfulness","answer_relevancy","context_precision","context_recall"]:
        val = result[k]
        if isinstance(val, list):
            valid = [v for v in val if v is not None and not (isinstance(v, float) and np.isnan(v))]
            scores[k] = round(sum(valid)/len(valid), 4) if valid else 0.0
        else:
            scores[k] = round(float(val), 4) if val is not None else 0.0
    return scores, detail

def evaluate_system(system_name, results_file, judge_key, all_scores, all_details):
    results = load_results(results_file)
    if not results: return
    questions_meta = load_questions_meta()

    print(f"\n{'='*60}")
    print(f"  {system_name}  |  Judge: {JUDGE_MODELS[judge_key]}")
    print(f"{'='*60}")

    # RAGAS 四指標
    ds = build_ragas_dataset(results, questions_meta)
    if len(ds) == 0: return
    ragas_scores, ragas_detail = run_ragas(ds, system_name, judge_key)

    # Topic Adherence
    ta_df   = compute_topic_adherence(results, questions_meta)
    ta_mean = round(ta_df["topic_adherence"].mean(), 4)
    print(f"  Topic Adherence     = {ta_mean:.4f}  ({int(ta_df['topic_adherence'].sum())}/{len(ta_df)})")

    # Tool Call Accuracy
    tca_df   = compute_tool_call_accuracy(results, questions_meta)
    tca_mean = round(tca_df["tool_call_correct"].mean(), 4)
    print(f"  Tool Call Accuracy  = {tca_mean:.4f}  ({int(tca_df['tool_call_correct'].sum())}/{len(tca_df)})")

    print(f"  Faithfulness       = {ragas_scores['faithfulness']:.4f}")
    print(f"  Answer Relevancy   = {ragas_scores['answer_relevancy']:.4f}")
    print(f"  Context Precision  = {ragas_scores['context_precision']:.4f}")
    print(f"  Context Recall     = {ragas_scores['context_recall']:.4f}")

    all_scores.append({
        "system": system_name, "judge_model": JUDGE_MODELS[judge_key],
        "faithfulness": ragas_scores["faithfulness"],
        "answer_relevancy": ragas_scores["answer_relevancy"],
        "context_precision": ragas_scores["context_precision"],
        "context_recall": ragas_scores["context_recall"],
        "topic_adherence": ta_mean,
        "tool_call_accuracy": tca_mean,
        "sample_count": len(ds),
        "evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    all_details.append(ragas_detail)

    # 儲存自定義指標詳細
    prefix = f"{system_name.replace(' ','_')}_{judge_key}"
    # ta_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_topic_adherence.csv"),
    #              index=False, encoding="utf-8-sig")
    # tca_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_tool_accuracy.csv"),
    #               index=False, encoding="utf-8-sig")
    ta_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_topic_adherence_2.csv"),
                 index=False, encoding="utf-8-sig")
    tca_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_tool_accuracy_2.csv"),
                  index=False, encoding="utf-8-sig")

def print_summary(all_scores):
    print("\n" + "="*90)
    print("  RAGAS 完整評估結果（6 指標）")
    print("="*90)
    df   = pd.DataFrame(all_scores)
    cols = ["system","judge_model","faithfulness","answer_relevancy",
            "context_precision","context_recall","topic_adherence","tool_call_accuracy"]
    print(df[cols].to_string(index=False))
    print("="*90)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    grp    = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--judge", choices=list(JUDGE_MODELS.keys()))
    grp.add_argument("--all", action="store_true")
    args   = parser.parse_args()

    all_scores, all_details = [], []
    judges = list(JUDGE_MODELS.keys()) if args.all else [args.judge]
    print(f"[主程式] Judges: {judges}")

    for jk in judges:
        # evaluate_system("Agentic RAG", "agentic_results.json", jk, all_scores, all_details)
        evaluate_system("Agentic RAG", "agentic_results_2.json", jk, all_scores, all_details)
        # Advanced RAG（完成後解除）
        # evaluate_system("Advanced RAG", "advanced_results.json", jk, all_scores, all_details)
        evaluate_system("Advanced RAG", "advanced_results_2.json", jk, all_scores, all_details)

    if all_scores:
        print_summary(all_scores)
        # summary_path = os.path.join(RESULTS_DIR, "ragas_summary.csv")
        summary_path = os.path.join(RESULTS_DIR, "ragas_summary_2.csv")
        df_new = pd.DataFrame(all_scores)
        if os.path.exists(summary_path):
            df_old = pd.read_csv(summary_path)
            df_combined = pd.concat([df_old, df_new], ignore_index=True)
        else:
            df_combined = df_new
        df_combined.to_csv(summary_path, index=False, encoding="utf-8-sig")
        if all_details:
            #detail_path = os.path.join(RESULTS_DIR, "ragas_detail.csv")
            detail_path = os.path.join(RESULTS_DIR, "ragas_detail_2.csv")
            df_new_detail = pd.concat(all_details, ignore_index=True)
            if os.path.exists(detail_path):
                df_old_detail = pd.read_csv(detail_path)
                df_combined_detail = pd.concat([df_old_detail, df_new_detail], ignore_index=True)
            else:
                df_combined_detail = df_new_detail
            df_combined_detail.to_csv(detail_path, index=False, encoding="utf-8-sig")
        print(f"\n[儲存完成] → {RESULTS_DIR}/")
    print("\n[完成]")
