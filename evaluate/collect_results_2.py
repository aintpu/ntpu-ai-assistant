# -*- coding: utf-8 -*-
import os, sys, json, time, re, uuid
from typing import List

config_path = "config.txt"
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                os.environ[k.strip()] = v.strip()

from openai import OpenAI
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY",""))

from langchain_core.documents import Document
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain.text_splitter import RecursiveCharacterTextSplitter
from rank_bm25 import BM25Okapi

FILE_PATH_ZH     = "all_content_v2.md"
REGULATIONS_PATH = "ALL_files.md"
MODEL_AGENT      = "gpt-5.4-mini"
MODEL_FAST       = "gpt-4o-mini"
REASONING_EFFORT = "high"

# QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions.json")
QUESTIONS_PATH = os.path.join(os.path.dirname(__file__), "test_questions_v2.json")
OUTPUT_DIR     = os.path.join(os.path.dirname(__file__), "results")
os.makedirs(OUTPUT_DIR, exist_ok=True)

CJK_RE = re.compile(r"[\u4e00-\u9fff]+")

def is_cjk(text): return bool(re.search(r"[\u4e00-\u9fff]", text))

def clean_answer(text):
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    return text.strip()

# ── 文件解析 ──────────────────────────────────────────────────
H1_RE     = re.compile(r"^#\s+(.+?)\s*$", re.M)
H3_RE     = re.compile(r"^###\s+(.+?)\s*$", re.M)
BOLD_LINK = re.compile(r"\*\*\s*\[([^\]]+?)\]\(([^)]+?)\)\s*\*\*")

def split_pages(md):
    pages, matches = [], list(H1_RE.finditer(md))
    for i, m in enumerate(matches):
        start = m.end(); end = matches[i+1].start() if i+1 < len(matches) else len(md)
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
        blocks.append({"date": m_date.group(1) if m_date else "", "title": title, "raw": chunk})
    return blocks

def parse_faqs(page_md):
    faqs, q, buf = [], "", []
    for line in page_md.splitlines():
        m = H3_RE.match(line)
        if m:
            if q: faqs.append({"question": q, "answer": "\n".join(buf).strip()})
            q, buf = m.group(1).strip(), []
        elif q: buf.append(line)
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
            docs.append(Document(page_content=f"【競賽成績紀錄】學年度：{year}，賽事名稱：{event}，競賽項目：{item}，名次：{rank}，參賽學生/隊伍：{name}",
                                  metadata={"page":"競賽成績","type":"grade","title":f"成績紀錄：{name} {event}"}))
    return docs

def parse_regulations(md_text):
    docs, lines = [], md_text.split("\n")
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
        elif line and cur_file: cur_content.append(line)
    if cur_content and cur_file:
        docs.append(Document(page_content="\n".join(cur_content).strip(),
                              metadata={"title":cur_file,"page":cur_page or "總覽","type":"regulation","source":"regulations"}))
    return docs

# ── 索引建立 ──────────────────────────────────────────────────
print("[初始化] 建立知識庫索引，請稍候...")
splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=150,
    separators=["\n#### ","\n### ","\n\n","\n"," "])
embeddings_model = OpenAIEmbeddings(model="text-embedding-3-small", chunk_size=100,
    openai_api_key=os.environ.get("OPENAI_API_KEY",""))

all_docs = []
if os.path.exists(FILE_PATH_ZH):
    with open(FILE_PATH_ZH, "r", encoding="utf-8") as f: md = f.read()
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
            if "競賽成績" in p_name: all_docs.extend(parse_grades_table(p_md))
            else: all_docs.append(Document(page_content=p_md, metadata={"page":p_name,"type":"page","title":p_name}))
if os.path.exists(REGULATIONS_PATH):
    with open(REGULATIONS_PATH, "r", encoding="utf-8") as f: all_docs.extend(parse_regulations(f.read()))

for i, d in enumerate(all_docs): d.metadata["doc_id"] = i

print(f"[初始化] 共 {len(all_docs)} 筆文件，建立 FAISS 索引中...")
faiss_index = FAISS.from_documents(all_docs, embeddings_model)

def zh_en_tok(s):
    tokens = []
    for p in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9_]+", s):
        if CJK_RE.fullmatch(p): tokens.extend([p] if len(p)==1 else [p[i:i+2] for i in range(len(p)-1)])
        else: tokens.append(p.lower())
    return tokens

bm25_corpus = [zh_en_tok(d.page_content) for d in all_docs]
bm25 = BM25Okapi(bm25_corpus)
print("[初始化] 完成！")

# ── 基本檢索（Agentic RAG 用）─────────────────────────────────
def retrieve_contexts(query: str, top_k: int = 6) -> List[str]:
    try:
        docs = faiss_index.similarity_search(query, k=top_k)
        rank_map = {}
        for rank, d in enumerate(docs, 1):
            did = d.metadata.get("doc_id", -1)
            if did >= 0: rank_map[did] = min(rank_map.get(did,999), rank)
        q_toks = zh_en_tok(query)
        scores  = bm25.get_scores(q_toks)
        for pos, did in enumerate(sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k], 1):
            rank_map[did] = min(rank_map.get(did,999), pos)
        fused      = {did: 1.0/(60+r) for did, r in rank_map.items()}
        sorted_ids = sorted(fused, key=lambda i: fused[i], reverse=True)[:top_k]
        return [all_docs[i].page_content[:800] for i in sorted_ids]
    except Exception as e:
        print(f"[檢索錯誤] {e}"); return []

# ── Advanced RAG 專用檢索（Pre + Retrieval + Post）────────────
def llm_rewrite_query(query: str) -> List[str]:
    try:
        rsp = client.chat.completions.create(
            model=MODEL_FAST, temperature=0.1, max_tokens=150,
            messages=[{"role":"system","content":"將使用者問題改寫成 3-5 個適合檢索的中文短句。"},
                      {"role":"user","content":query}])
        return [s.strip() for s in rsp.choices[0].message.content.splitlines() if s.strip()]
    except: return [query]

def hyde_expand(query: str) -> str:
    try:
        rsp = client.chat.completions.create(
            model=MODEL_FAST, temperature=0.2, max_completion_tokens=150, # 將 max_tokens 改為 max_completion_tokens
            messages=[{"role":"system","content":"撰寫80字中文摘要，包含關鍵名詞，供檢索用。"},
                      {"role":"user","content":query}])
        return rsp.choices[0].message.content.strip()
    except: return query

def retrieve_contexts_advanced(query: str, top_k: int = 6) -> List[str]:
    try:
        variants = list(dict.fromkeys([query] + llm_rewrite_query(query) + [hyde_expand(query)]))[:5]
        rank_map = {}
        for v in variants:
            for rank, d in enumerate(faiss_index.similarity_search(v, k=top_k), 1):
                did = d.metadata.get("doc_id", -1)
                if did >= 0: rank_map[did] = min(rank_map.get(did,999), rank)
        q_toks = [t for v in variants for t in zh_en_tok(v)]
        scores  = bm25.get_scores(q_toks)
        for pos, did in enumerate(sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k], 1):
            rank_map[did] = min(rank_map.get(did,999), pos)
        fused      = {did: 1.0/(60+r) for did, r in rank_map.items()}
        sorted_ids = sorted(fused, key=lambda i: fused[i], reverse=True)[:top_k*2]
        candidates = [all_docs[i] for i in sorted_ids]
        # LLM Rerank
        if candidates:
            items = [f"[{i+1}] {d.page_content[:300]}" for i, d in enumerate(candidates[:10])]
            try:
                rsp = client.chat.completions.create(
                    model=MODEL_FAST, temperature=0,
                    messages=[{"role":"system","content":"Score snippets 0-3 for relevance to query. Return JSON array of numbers."},
                              {"role":"user","content":f"Query: {query}\n\n" + "\n".join(items)}])
                rerank_scores = json.loads(rsp.choices[0].message.content)
                candidates = [d for _, d in sorted(zip(rerank_scores, candidates[:10]), key=lambda x: x[0], reverse=True)]
            except: pass
        return [d.page_content[:800] for d in candidates[:top_k]]
    except Exception as e:
        print(f"[Advanced 檢索錯誤] {e}"); return []

# ── Agentic RAG 生成 ──────────────────────────────────────────
SYSTEM_PROMPT = (
    "你是國立臺北大學體育室（OPE）的智能助理。"
    "只能回答體育室相關業務與體育運動一般知識。請使用繁體中文回答。"
)
TOOLS = [
    {"type":"function","name":"get_latest_news","description":"查詢最新消息、公告、通知",
     "parameters":{"type":"object","properties":{"keyword":{"type":"string"}}}},
    {"type":"function","name":"get_competition_records","description":"查詢競賽成績、比賽名次",
     "parameters":{"type":"object","properties":{"keyword":{"type":"string"},"year":{"type":"string"},"name":{"type":"string"}}}},
    {"type":"function","name":"search_regulations_and_general","description":"檢索場地借用、法規或一般問題",
     "parameters":{"type":"object","properties":{"search_query":{"type":"string"}},"required":["search_query"]}},
]

def get_agentic_answer(question: str) -> str:
    input_messages = [{"role":"system","content":SYSTEM_PROMPT},{"role":"user","content":question}]
    answer = "很抱歉，目前無法找到相關資訊。"
    for _ in range(3):
        try:
            resp = client.responses.create(model=MODEL_AGENT, reasoning={"effort":REASONING_EFFORT},
                                           input=input_messages, tools=TOOLS)
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
                if item.type in ("reasoning","function_call"): input_messages.append(item)
            for tc in tool_calls:
                args = json.loads(tc.arguments)
                ctx  = "\n".join(retrieve_contexts(args.get("search_query") or args.get("keyword","") or question))
                input_messages.append({"type":"function_call_output","call_id":tc.call_id,"output":ctx or "查無資料"})
        except Exception as e:
            print(f"  [Agent 錯誤] {e}"); break
    return answer

# ── Advanced RAG 生成 ─────────────────────────────────────────
SYSTEM_PROMPT_ADVANCED = (
    "你是國立臺北大學體育室（OPE）的智能助理。"
    "只能回答體育室相關業務與體育運動一般知識。請使用繁體中文回答。"
    "你必須依賴提供的 Context 來回答，不可自行捏造。找不到答案請說查無相關資訊。"
)

def get_advanced_answer(question: str) -> str:
    contexts    = retrieve_contexts_advanced(question, top_k=6)
    context_str = "\n\n---\n\n".join(contexts) if contexts else "查無相關資訊。"
    messages = [
        {"role":"system","content":SYSTEM_PROMPT_ADVANCED},
        {"role":"user","content":f"以下是從知識庫檢索到的相關資訊：\n\n{context_str}\n\n根據以上資訊，請回答：{question}"}
    ]
    try:
        rsp = client.chat.completions.create(model=MODEL_AGENT, temperature=0.1,
                                             max_completion_tokens=1500, messages=messages)
        return rsp.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [Advanced RAG 錯誤] {e}")
        return "很抱歉，目前無法找到相關資訊。"

# ── 主程式 ────────────────────────────────────────────────────
def main():
    with open(QUESTIONS_PATH, "r", encoding="utf-8") as f:
        questions = json.load(f)

    # ── Agentic RAG（已跑過可以註解掉這段）──────────────────
    # print(f"\n[Agentic RAG] 共 {len(questions)} 題...\n")
    # agentic_results = []
    # for i, q in enumerate(questions, 1):
    #     question = q["question"]
    #     print(f"  [{i:03d}/{len(questions)}] {question[:40]}...")
    #     answer   = clean_answer(get_agentic_answer(question))
    #     contexts = retrieve_contexts(question, top_k=6)
    #     agentic_results.append({"id":q["id"],"question":question,"answer":answer,
    #                             "contexts":contexts,"category":q.get("category","")})
    #     time.sleep(1.5)
    # out = os.path.join(OUTPUT_DIR, "agentic_results.json")
    # with open(out, "w", encoding="utf-8") as f:
    #     json.dump(agentic_results, f, ensure_ascii=False, indent=2)
    # print(f"[完成] Agentic RAG → {out}")

    # ── Advanced RAG ─────────────────────────────────────────
    print(f"\n[Advanced RAG] 共 {len(questions)} 題...\n")
    advanced_results = []
    for i, q in enumerate(questions, 1):
        question = q["question"]
        print(f"  [{i:03d}/{len(questions)}] {question[:40]}...")
        answer   = clean_answer(get_advanced_answer(question))
        contexts = retrieve_contexts_advanced(question, top_k=6)
        advanced_results.append({"id":q["id"],"question":question,"answer":answer,
                                  "contexts":contexts,"category":q.get("category","")})
        time.sleep(1.5)
    # out = os.path.join(OUTPUT_DIR, "advanced_results.json")
    out = os.path.join(OUTPUT_DIR, "advanced_results_2.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(advanced_results, f, ensure_ascii=False, indent=2)
    answered = sum(1 for r in advanced_results if r["answer"] and "無法找到" not in r["answer"])
    print(f"\n[完成] Advanced RAG：{answered}/{len(questions)} 題有實質回答 → {out}")
    print("\n[下一步] conda activate ragas_env && python evaluate\\ragas_eval.py --judge llama3")

if __name__ == "__main__":
    main()
