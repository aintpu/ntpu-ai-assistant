# -*- coding: utf-8 -*-
"""
collect_results.py  -  完全獨立版（不 import agentic 主程式）
直接初始化必要元件，繞開 torch/transformers 衝突問題

執行：
    conda activate AIIT
    cd C:/Users/imntpu/Desktop/NTPUOPE
    python evaluate/collect_results.py
"""

import os, sys, json, time, re, uuid
from typing import List

# ── 讀取 config ───────────────────────────────────────────────
config_path = "config.txt"
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                os.environ[k.strip()] = v.strip()

from openai import OpenAI
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY",""))

# ── Langchain（你環境裡有的版本）────────────────────────────
from langchain_core.documents import Document
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain.text_splitter import RecursiveCharacterTextSplitter
from rank_bm25 import BM25Okapi

# ── 常數 ─────────────────────────────────────────────────────
FILE_PATH_ZH     = "all_content_v2.md"
REGULATIONS_PATH = "ALL_files.md"
MODEL_AGENT      = "gpt-5.4-mini"
MODEL_FAST       = "gpt-4o-mini"
REASONING_EFFORT = "high"
SESSION_ID       = str(uuid.uuid4())

# QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions.json")
QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions_v2.json")
OUTPUT_DIR     = os.path.join(os.path.dirname(__file__), "results")
os.makedirs(OUTPUT_DIR, exist_ok=True)

CJK_RE = re.compile(r"[\u4e00-\u9fff]+")

def is_cjk(text):
    return bool(re.search(r"[\u4e00-\u9fff]", text))

def clean_answer(text):
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    return text.strip()

# ══════════════════════════════════════════════════════════════
# 1. 索引建立（從 MD 檔直接建，不依賴 agentic 主程式）
# ══════════════════════════════════════════════════════════════
H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.M)
H3_RE = re.compile(r"^###\s+(.+?)\s*$", re.M)
BOLD_LINK = re.compile(r"\*\*\s*\[([^\]]+?)\]\(([^)]+?)\)\s*\*\*")

def split_pages(md):
    pages = []
    matches = list(H1_RE.finditer(md))
    for i, m in enumerate(matches):
        start = m.end()
        end   = matches[i+1].start() if i+1 < len(matches) else len(md)
        pages.append((m.group(1).strip(), md[start:end].strip()))
    return pages

def parse_news_blocks(page_md):
    blocks = []
    for chunk in re.split(r"\n-{3,}\n", page_md):
        chunk = chunk.strip()
        if not chunk: continue
        m = BOLD_LINK.search(chunk)
        title = m.group(1).strip() if m else "最新消息"
        m_date = re.search(r"##\s*(\d{4}\s*/\s*\d{1,2}\s*/\s*\d{1,2})", chunk)
        date_str = m_date.group(1) if m_date else ""
        blocks.append({"date": date_str, "title": title, "raw": chunk})
    return blocks

def parse_faqs(page_md):
    faqs, q, buf = [], "", []
    for line in page_md.splitlines():
        m = H3_RE.match(line)
        if m:
            if q: faqs.append({"question": q, "answer": "\n".join(buf).strip()})
            q, buf = m.group(1).strip(), []
        elif q:
            buf.append(line)
    if q: faqs.append({"question": q, "answer": "\n".join(buf).strip()})
    return faqs

def parse_grades_table(md_text):
    docs = []
    for line in md_text.strip().split("\n"):
        line = line.strip()
        if not line.startswith("|") or "---" in line: continue
        cols = [c.strip() for c in line.split("|")[1:-1]]
        if "學年度" in line or "賽事名稱" in line: continue
        if len(cols) >= 5:
            year, event, item, rank, name = cols[:5]
            row_text = f"【競賽成績紀錄】學年度：{year}，賽事名稱：{event}，競賽項目：{item}，名次：{rank}，參賽學生/隊伍：{name}"
            docs.append(Document(page_content=row_text,
                                  metadata={"page":"競賽成績","type":"grade","title":f"成績紀錄：{name} {event}"}))
    return docs

def parse_regulations(md_text):
    docs = []
    lines = md_text.split("\n")
    cur_file, cur_page, cur_content = "", "", []
    for line in lines:
        line = line.strip()
        if line.startswith("## ") and not line.startswith("### "):
            if cur_content and cur_file:
                docs.append(Document(page_content="\n".join(cur_content).strip(),
                                      metadata={"title":cur_file,"page":cur_page or "總覽","type":"regulation","source":"regulations"}))
            cur_file = line[3:].strip(); cur_page = ""; cur_content = []
        elif line.startswith("### "):
            if cur_content and cur_file:
                docs.append(Document(page_content="\n".join(cur_content).strip(),
                                      metadata={"title":cur_file,"page":cur_page or "總覽","type":"regulation","source":"regulations"}))
            cur_page = line[4:].strip(); cur_content = []
        elif line and cur_file:
            cur_content.append(line)
    if cur_content and cur_file:
        docs.append(Document(page_content="\n".join(cur_content).strip(),
                              metadata={"title":cur_file,"page":cur_page or "總覽","type":"regulation","source":"regulations"}))
    return docs

print("[初始化] 建立知識庫索引，請稍候...")

splitter = RecursiveCharacterTextSplitter(
    chunk_size=800, chunk_overlap=150,
    separators=["\n#### ", "\n### ", "\n\n", "\n", " "]
)
embeddings_model = OpenAIEmbeddings(
    model="text-embedding-3-small",
    chunk_size=100,
    openai_api_key=os.environ.get("OPENAI_API_KEY","")
)

all_docs = []
if os.path.exists(FILE_PATH_ZH):
    with open(FILE_PATH_ZH, "r", encoding="utf-8") as f:
        md = f.read()
    pages_dict = {t: c for t, c in split_pages(md)}
    for it in parse_news_blocks(pages_dict.get("最新消息","")):
        raw = it["raw"]
        if len(raw) < 800:
            all_docs.append(Document(page_content=raw, metadata={"page":"最新消息","type":"news","title":it["title"],"date":it["date"]}))
        else:
            for chunk in splitter.split_text(raw):
                all_docs.append(Document(page_content=chunk, metadata={"page":"最新消息","type":"news","title":it["title"],"date":it["date"]}))
    for qa in parse_faqs(pages_dict.get("常見問題","")):
        all_docs.append(Document(page_content=f"Q: {qa['question']}\n\nA:\n{qa['answer']}",
                                  metadata={"page":"常見問題","type":"faq","title":qa["question"]}))
    for p_name, p_md in pages_dict.items():
        if p_name not in ("最新消息","常見問題"):
            if "競賽成績" in p_name:
                all_docs.extend(parse_grades_table(p_md))
            else:
                all_docs.append(Document(page_content=p_md, metadata={"page":p_name,"type":"page","title":p_name}))

if os.path.exists(REGULATIONS_PATH):
    with open(REGULATIONS_PATH, "r", encoding="utf-8") as f:
        all_docs.extend(parse_regulations(f.read()))

for i, d in enumerate(all_docs):
    d.metadata["doc_id"] = i

print(f"[初始化] 共 {len(all_docs)} 筆文件，建立 FAISS 索引中...")
faiss_index = FAISS.from_documents(all_docs, embeddings_model)

def zh_en_tok(s):
    parts = re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9_]+", s)
    tokens = []
    for p in parts:
        if CJK_RE.fullmatch(p):
            tokens.extend([p] if len(p)==1 else [p[i:i+2] for i in range(len(p)-1)])
        else:
            tokens.append(p.lower())
    return tokens

bm25_corpus = [zh_en_tok(d.page_content) for d in all_docs]
bm25 = BM25Okapi(bm25_corpus)
print("[初始化] 完成！")

# ══════════════════════════════════════════════════════════════
# 2. 檢索函數
# ══════════════════════════════════════════════════════════════
def retrieve_contexts(query: str, top_k: int = 6) -> List[str]:
    try:
        # FAISS 語意檢索
        rank_map = {}
        docs = faiss_index.similarity_search(query, k=top_k)
        for rank, d in enumerate(docs, 1):
            did = d.metadata.get("doc_id", -1)
            if did >= 0: rank_map[did] = min(rank_map.get(did, 999), rank)

        # BM25 關鍵字檢索
        q_toks = zh_en_tok(query)
        scores  = bm25.get_scores(q_toks)
        for pos, did in enumerate(
            sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k], 1
        ):
            rank_map[did] = min(rank_map.get(did, 999), pos)

        # RRF 融合
        fused      = {did: 1.0/(60+r) for did, r in rank_map.items()}
        sorted_ids = sorted(fused, key=lambda i: fused[i], reverse=True)[:top_k]
        return [all_docs[i].page_content[:800] for i in sorted_ids]
    except Exception as e:
        print(f"[檢索錯誤] {e}"); return []

# ══════════════════════════════════════════════════════════════
# 3. 呼叫 Agentic RAG 取得回答
# ══════════════════════════════════════════════════════════════
SYSTEM_PROMPT = (
    "你是國立臺北大學體育室（OPE）的智能助理。"
    "只能回答體育室相關業務與體育運動一般知識。"
    "請使用繁體中文回答。"
)

TOOLS = [
    {"type":"function","name":"get_latest_news",
     "description":"查詢最新消息、公告、通知",
     "parameters":{"type":"object","properties":{"keyword":{"type":"string"}}}},
    {"type":"function","name":"get_competition_records",
     "description":"查詢競賽成績、比賽名次",
     "parameters":{"type":"object","properties":{
         "keyword":{"type":"string"},"year":{"type":"string"},"name":{"type":"string"}}}},
    {"type":"function","name":"search_regulations_and_general",
     "description":"檢索場地借用、法規或一般問題",
     "parameters":{"type":"object","properties":{"search_query":{"type":"string"}},"required":["search_query"]}},
]

def get_agentic_answer(question: str) -> str:
    input_messages = [
        {"role":"system","content":SYSTEM_PROMPT},
        {"role":"user","content":question}
    ]
    answer = "很抱歉，目前無法找到相關資訊。"
    for _ in range(3):
        try:
            resp = client.responses.create(
                model=MODEL_AGENT,
                reasoning={"effort": REASONING_EFFORT},
                input=input_messages,
                tools=TOOLS,
            )
            tool_calls = [i for i in resp.output if i.type == "function_call"]
            text_items = [i for i in resp.output if i.type == "message"]
            if not tool_calls:
                if text_items:
                    content = text_items[-1].content
                    if isinstance(content, str): answer = content
                    elif isinstance(content, list):
                        for block in content:
                            if hasattr(block,"text"): answer = block.text; break
                break
            for item in resp.output:
                if item.type in ("reasoning","function_call"):
                    input_messages.append(item)
            for tc in tool_calls:
                args = json.loads(tc.arguments)
                ctx  = "\n".join(retrieve_contexts(
                    args.get("search_query") or args.get("keyword","") or question
                ))
                input_messages.append({"type":"function_call_output","call_id":tc.call_id,"output":ctx or "查無資料"})
        except Exception as e:
            print(f"  [Agent 錯誤] {e}"); break
    return answer

# ══════════════════════════════════════════════════════════════
# 4. 主程式：跑 100 題
# ══════════════════════════════════════════════════════════════
def main():
    with open(QUESTIONS_PATH, "r", encoding="utf-8") as f:
        questions = json.load(f)
    print(f"\n[主程式] 共 {len(questions)} 題，開始收集 Agentic RAG 答案...\n")

    results = []
    for i, q in enumerate(questions, 1):
        question = q["question"]
        print(f"  [{i:03d}/{len(questions)}] {question[:40]}...")
        answer   = clean_answer(get_agentic_answer(question))
        contexts = retrieve_contexts(question, top_k=6)
        results.append({
            "id": q["id"], "question": question,
            "answer": answer, "contexts": contexts,
            "category": q.get("category",""),
        })
        if not answer: print(f"    [警告] 回答為空")
        time.sleep(1.5)

    # out = os.path.join(OUTPUT_DIR, "agentic_results.json")
    out = os.path.join(OUTPUT_DIR, "agentic_results_2.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    answered = sum(1 for r in results if r["answer"] and "無法找到" not in r["answer"])
    print(f"\n[完成] {answered}/{len(questions)} 題有實質回答")
    print(f"[儲存] → {out}")
    print("\n[下一步] python evaluate\\ragas_eval.py --judge nemotron")

if __name__ == "__main__":
    main()
