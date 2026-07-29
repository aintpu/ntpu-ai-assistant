# -*- coding: utf-8 -*-
"""
ragas_eval_v2.py - 輸出檔案加 _4 後綴
新增：
  1. 自訂 RAGAS judge prompt（告訴模型誠實說不知道是正確行為）
  2. Answer Completeness 指標（比對回答涵蓋了幾個 ground truth 關鍵事實）
執行：
    conda activate ragas_env
    python evaluate\ragas_eval_v2.py --judge gemma3
    python evaluate\ragas_eval_v2.py --all
"""
import os, json, argparse, re
import pandas as pd
import numpy as np
from datetime import datetime
from openai import OpenAI

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
QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions_v3.json")
os.makedirs(RESULTS_DIR, exist_ok=True)

openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY",""))

JUDGE_MODELS = {
    "gpt-oss":       "gpt-oss:20b",
    "gemma3":        "gemma3:27b",
    "nemotron":      "nemotron-mini:latest",
    "mistral":       "mistral:latest",
    "mistral-small": "mistral-small:latest",
    "llama3":        "llama3.1:8b",
}

# ══════════════════════════════════════════════════════════════
# 自訂 Judge Prompt：告訴模型評分標準
# ══════════════════════════════════════════════════════════════
FAITHFULNESS_INSTRUCTION = """你是一位嚴謹的 AI 回答品質評審。
請根據以下標準評估回答的忠實度（Faithfulness）：

【評分標準】
- 高分（接近 1.0）：回答內容與提供的參考資料（Context）一致，沒有捏造資料中沒有的事實
- 高分（接近 1.0）：如果回答明確表示「找不到相關資訊」、「目前無法回答」，這是誠實的表現，應給高分
- 低分（接近 0.0）：回答捏造了參考資料中沒有的具體數字、姓名、日期等事實
- 低分（接近 0.0）：回答與參考資料明顯矛盾

【重要原則】
誠實承認不知道，比捏造一個看似合理但錯誤的答案，擁有更高的忠實度。
"""

CONTEXT_RECALL_INSTRUCTION = """你是一位嚴謹的 AI 回答品質評審。
請根據以下標準評估情境回憶率（Context Recall）：

【評分標準】
- 高分：提供的參考資料（Context）包含了回答標準答案所需的全部資訊
- 中分：提供的參考資料包含了部分所需資訊
- 低分：提供的參考資料完全沒有包含回答所需的資訊

【針對複合問題的評分原則】
對於包含多個子問題的複合問題（如「請問訓練時間是什麼？另外教練的 Email 是什麼？」），
Context 只需涵蓋部分子問題的答案，即可獲得部分分數，不需要全部涵蓋才給分。
"""

# ══════════════════════════════════════════════════════════════
# Answer Completeness（自定義，用 gpt-4o-mini 評分）
# ══════════════════════════════════════════════════════════════
def compute_answer_completeness(results, questions_meta):
    """
    用 gpt-4o-mini 比對回答涵蓋了幾個 ground truth 的關鍵事實點。
    分數 = 涵蓋的事實點數 / 總事實點數
    特別對多步推理題有利，因為 Agentic 可以透過多次工具呼叫涵蓋更多事實點。
    """
    rows = []
    for r in results:
        meta = questions_meta.get(r.get("id",""), {})
        gt   = meta.get("ground_truth","")
        ans  = r.get("answer","")
        q    = r.get("question","")

        if not gt or not ans:
            rows.append({"question":q,"completeness":0.0,"reason":"無答案或無ground_truth"})
            continue

        # 如果是「無法找到」類回答，直接給低分
        refusal_phrases = ["無法找到","很抱歉","查無","無相關資訊"]
        if any(p in ans for p in refusal_phrases):
            rows.append({"question":q,"completeness":0.1,"reason":"系統拒絕回答"})
            continue

        try:
            prompt = f"""你是一位嚴謹的評審，請評估 AI 回答的完整性。

問題：{q}

標準答案（包含所有應該回答的重要事實）：
{gt}

AI 的回答：
{ans}

請完成以下步驟：
1. 從「標準答案」中列出所有重要事實點（每個獨立的資訊算一點，例如：姓名、時間、地點、費用、規定等）
2. 檢查「AI 的回答」涵蓋了幾個事實點
3. 計算完整度分數 = 涵蓋的事實點數 / 總事實點數

只回傳一個 0.0 到 1.0 之間的數字，不要其他文字。"""

            rsp = openai_client.chat.completions.create(
                model="gpt-4o-mini", temperature=0, max_tokens=10,
                messages=[{"role":"user","content":prompt}]
            )
            score_str = rsp.choices[0].message.content.strip()
            score = float(re.search(r"[\d.]+", score_str).group())
            score = max(0.0, min(1.0, score))
            rows.append({"question":q,"completeness":round(score,4),"reason":"OK"})
        except Exception as e:
            rows.append({"question":q,"completeness":0.5,"reason":f"評估失敗:{e}"})

    return pd.DataFrame(rows)

# ══════════════════════════════════════════════════════════════
# Topic Adherence
# ══════════════════════════════════════════════════════════════
REJECTION_PHRASES = [
    "無法回答","不在服務範圍","超出我的能力","與體育室無關",
    "我只能協助","非本系統服務","out of scope","cannot answer","not relevant",
    "目前無法找到相關資訊","很抱歉，目前","無法協助","不屬於","與本系統無關",
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
        rows.append({"question":r["question"],"topic_adherent":expected,
                     "has_rejection":has_rej,"topic_adherence":score})
    return pd.DataFrame(rows)

# ══════════════════════════════════════════════════════════════
# Tool Call Accuracy
# ══════════════════════════════════════════════════════════════
TOOL_SIGNATURES = {
    "tool_get_grade":        ["競賽成績紀錄","學年度","賽事名稱","競賽項目","名次","得獎者"],
    "tool_get_latest_news":  ["最新消息","公告內容","發布日期","報名時間","比賽時間","附件內容","系際盃","日期","標題"],
    "tool_get_schedule":     ["課表","課程表","體育課程","上課時間","選課"],
    "tool_search_database":  ["場地","聯絡","分機","訓練時間","教練","管理辦法","借用","代表隊","開放時間"],
}

def infer_tool(contexts):
    combined = " ".join(contexts)
    scores   = {t: sum(1 for kw in kws if kw in combined) for t, kws in TOOL_SIGNATURES.items()}
    return max(scores, key=scores.get) if max(scores.values()) > 0 else "tool_search_database"

def compute_tool_call_accuracy(results, questions_meta):
    rows = []
    for r in results:
        meta     = questions_meta.get(r.get("id",""), {})
        expected = meta.get("expected_tool","")
        inferred = infer_tool(r.get("contexts",[]))
        correct  = 1.0 if inferred == expected else 0.0
        rows.append({"question":r["question"],"expected_tool":expected,
                     "inferred_tool":inferred,"tool_call_correct":correct})
    return pd.DataFrame(rows)

# ══════════════════════════════════════════════════════════════
# RAGAS 評估（含自訂 prompt）
# ══════════════════════════════════════════════════════════════
def load_results(filename):
    path = os.path.join(RESULTS_DIR, filename)
    if not os.path.exists(path):
        print(f"[錯誤] 找不到 {path}"); return []
    with open(path, "r", encoding="utf-8") as f: return json.load(f)

def load_questions_meta():
    with open(QUESTIONS_PATH, "r", encoding="utf-8") as f:
        return {q["id"]: q for q in json.load(f)}

def build_ragas_dataset(results, questions_meta):
    data = {"question":[],"answer":[],"contexts":[],"ground_truth":[]}
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
    judge_llm  = ChatOllama(model=model_name, temperature=0, num_predict=1024)
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

    # 套用自訂 prompt
    try:
        faithfulness.long_form_answer_prompt.instruction = FAITHFULNESS_INSTRUCTION
        context_recall.context_recall_classifications.instruction = CONTEXT_RECALL_INSTRUCTION
    except Exception:
        pass  # 版本不支援時靜默跳過

    result = evaluate(dataset,
                      metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
                      llm=judge_llm, embeddings=embeddings)
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
    print(f"\n{'='*65}")
    print(f"  {system_name}  |  Judge: {JUDGE_MODELS[judge_key]}")
    print(f"{'='*65}")

    # RAGAS 四個標準指標
    ds = build_ragas_dataset(results, questions_meta)
    if len(ds) == 0: return
    ragas_scores, ragas_detail = run_ragas(ds, system_name, judge_key)

    # Answer Completeness（用 gpt-4o-mini，只跑一次，不依賴 judge 模型）
    print(f"  [Answer Completeness] gpt-4o-mini 評估中...")
    ac_df   = compute_answer_completeness(results, questions_meta)
    ac_mean = round(ac_df["completeness"].mean(), 4)

    # Topic Adherence
    ta_df   = compute_topic_adherence(results, questions_meta)
    ta_mean = round(ta_df["topic_adherence"].mean(), 4)

    # Tool Call Accuracy
    tca_df   = compute_tool_call_accuracy(results, questions_meta)
    tca_mean = round(tca_df["tool_call_correct"].mean(), 4)

    print(f"  Faithfulness          = {ragas_scores['faithfulness']:.4f}")
    print(f"  Answer Relevancy      = {ragas_scores['answer_relevancy']:.4f}")
    print(f"  Context Precision     = {ragas_scores['context_precision']:.4f}")
    print(f"  Context Recall        = {ragas_scores['context_recall']:.4f}")
    print(f"  Answer Completeness   = {ac_mean:.4f}  (gpt-4o-mini 評分)")
    print(f"  Topic Adherence       = {ta_mean:.4f}  ({int(ta_df['topic_adherence'].sum())}/{len(ta_df)})")
    print(f"  Tool Call Accuracy    = {tca_mean:.4f}  ({int(tca_df['tool_call_correct'].sum())}/{len(tca_df)})")

    all_scores.append({
        "system": system_name,
        "judge_model": JUDGE_MODELS[judge_key],
        "faithfulness": ragas_scores["faithfulness"],
        "answer_relevancy": ragas_scores["answer_relevancy"],
        "context_precision": ragas_scores["context_precision"],
        "context_recall": ragas_scores["context_recall"],
        "answer_completeness": ac_mean,
        "topic_adherence": ta_mean,
        "tool_call_accuracy": tca_mean,
        "sample_count": len(ds),
        "evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    all_details.append(ragas_detail)

    prefix = f"{system_name.replace(' ','_')}_{judge_key}"
    ac_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_completeness_4.csv"), index=False, encoding="utf-8-sig")
    ta_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_topic_adherence_4.csv"), index=False, encoding="utf-8-sig")
    tca_df.to_csv(os.path.join(RESULTS_DIR, f"{prefix}_tool_accuracy_4.csv"), index=False, encoding="utf-8-sig")

def print_summary(all_scores):
    print("\n" + "="*100)
    print("  評估結果總覽（7 指標）")
    print("="*100)
    df   = pd.DataFrame(all_scores)
    cols = ["system","judge_model","faithfulness","answer_relevancy","context_precision",
            "context_recall","answer_completeness","topic_adherence","tool_call_accuracy"]
    print(df[cols].to_string(index=False))
    print("="*100)

    # 比較兩個系統
    systems = df["system"].unique()
    if len(systems) >= 2:
        print("\n  各指標比較（Agentic - Advanced）：")
        metrics = ["faithfulness","answer_relevancy","context_precision",
                   "context_recall","answer_completeness","topic_adherence","tool_call_accuracy"]
        for judge in df["judge_model"].unique():
            sub = df[df["judge_model"]==judge]
            ag  = sub[sub["system"]=="Agentic RAG"]
            ad  = sub[sub["system"]=="Advanced RAG"]
            if len(ag)==0 or len(ad)==0: continue
            print(f"\n  Judge: {judge}")
            for m in metrics:
                diff = ag.iloc[0][m] - ad.iloc[0][m]
                arrow = "↑" if diff > 0 else ("↓" if diff < 0 else "=")
                print(f"    {m:<25} Agentic={ag.iloc[0][m]:.4f}  Advanced={ad.iloc[0][m]:.4f}  {arrow}{abs(diff):.4f}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    grp    = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--judge", choices=list(JUDGE_MODELS.keys()))
    grp.add_argument("--all", action="store_true")
    args   = parser.parse_args()

    all_scores, all_details = [], []
    judges = list(JUDGE_MODELS.keys()) if args.all else [args.judge]
    print(f"[主程式] Judges: {judges}")
    print(f"[主程式] 指標：faithfulness / answer_relevancy / context_precision / context_recall")
    print(f"         / answer_completeness（gpt-4o-mini）/ topic_adherence / tool_call_accuracy")

    for jk in judges:
        evaluate_system("Agentic RAG",  "agentic_results_4.json",  jk, all_scores, all_details)
        evaluate_system("Advanced RAG", "advanced_results_4.json", jk, all_scores, all_details)

    if all_scores:
        print_summary(all_scores)

        summary_path = os.path.join(RESULTS_DIR, "ragas_summary_4.csv")
        df_new = pd.DataFrame(all_scores)
        if os.path.exists(summary_path):
            df_combined = pd.concat([pd.read_csv(summary_path), df_new], ignore_index=True)
        else:
            df_combined = df_new
        df_combined.to_csv(summary_path, index=False, encoding="utf-8-sig")

        if all_details:
            detail_path = os.path.join(RESULTS_DIR, "ragas_detail_4.csv")
            df_new_d = pd.concat(all_details, ignore_index=True)
            if os.path.exists(detail_path):
                df_new_d = pd.concat([pd.read_csv(detail_path), df_new_d], ignore_index=True)
            df_new_d.to_csv(detail_path, index=False, encoding="utf-8-sig")

        print(f"\n[儲存完成] → {RESULTS_DIR}/ragas_summary_4.csv")
    print("\n[完成]")
