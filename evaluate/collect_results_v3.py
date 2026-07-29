# -*- coding: utf-8 -*-
# collect_results_v3.py
# 工具函數邏輯完全對齊 agentic_v2_5_4high.py
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
from urllib.parse import unquote

FILE_PATH_ZH     = "all_content_v2.md"
REGULATIONS_PATH = "ALL_files.md"
MODEL_AGENT      = "gpt-5.4-mini"
MODEL_FAST       = "gpt-4o-mini"
REASONING_EFFORT = "high"

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

def roc_to_ad_year(s: str) -> str:
    def repl(m):
        return str(int(m.group(1)) + 1911)
    s = re.sub(r"(?:民國)?\s*(\d{2,3})\s*年", repl, s)
    s = re.sub(r"(?:民國)?\s*(\d{2,3})\s*學年", repl, s)
    return s

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
            docs.append(Document(
                page_content=f"【競賽成績紀錄】學年度：{year}，賽事名稱：{event}，競賽項目：{item}，名次：{rank}，參賽學生/隊伍：{name}",
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
if os.path.exists("corrections.md"):
    with open("corrections.md", "r", encoding="utf-8") as f:
        for chunk in f.read().split("\n\n"):
            if chunk.strip():
                all_docs.append(Document(page_content=chunk.strip(),
                    metadata={"page":"系統修正紀錄","type":"correction","title":"使用者糾正資訊"}))

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

# ══════════════════════════════════════════════════════════════
# 工具函數（完全對齊原始系統邏輯）
# ══════════════════════════════════════════════════════════════

# ── 通用 retrieve_and_rerank（含 query rewrite + HyDE）────────
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
            model=MODEL_FAST, temperature=0.2, max_tokens=150,
            messages=[{"role":"system","content":"撰寫80字中文摘要，包含關鍵名詞，供檢索用。"},
                      {"role":"user","content":query}])
        return rsp.choices[0].message.content.strip()
    except: return query

def retrieve_and_rerank(query: str, top_k: int = 6) -> List[Document]:
    """完全對齊原始系統的 retrieve_and_rerank，含 rewrite + HyDE + FAISS + BM25 + RRF + LLM Rerank"""
    if not all_docs: return []
    variants = [query] + llm_rewrite_query(query) + [hyde_expand(query)]
    variants = list(dict.fromkeys(variants))[:5]

    rank_map = {}
    vecs = embeddings_model.embed_documents(variants)
    for v in vecs:
        docs = faiss_index.similarity_search_by_vector(v, k=top_k)
        for rank, d in enumerate(docs, 1):
            did = d.metadata.get("doc_id", -1)
            if did >= 0: rank_map[did] = min(rank_map.get(did,999), rank)

    q_tokens = [t for v in variants for t in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9_]+", v)]
    scores   = bm25.get_scores(q_tokens)
    for pos, did in enumerate(sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k], 1):
        rank_map[did] = min(rank_map.get(did,999), pos)

    fused      = {did: 1.0/(60+r) for did, r in rank_map.items()}
    sorted_ids = sorted(fused.keys(), key=lambda i: fused[i], reverse=True)[:top_k*2]
    candidates = [all_docs[i] for i in sorted_ids]

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

    return candidates[:top_k]

def build_context_snippets(hits: List[Document], max_chars: int = 1500) -> str:
    return "\n\n---\n\n".join([f"Title: {d.metadata.get('title','')}\nContent:\n{d.page_content[:max_chars]}" for d in hits])

# ── 工具1：get_schedule（對齊原始）───────────────────────────
def tool_get_schedule(year=None) -> str:
    cand = [d for d in all_docs if "課表" in d.metadata.get("title","") or "課表" in d.page_content or "課程表" in d.page_content]
    cand = sorted(cand, key=lambda d: d.metadata.get("date",""), reverse=True)
    if not cand: return "查無相關課表資訊。"
    if year:
        by_year = [d for d in cand if str(year) in d.page_content or str(year-1911) in d.page_content]
        if by_year: return by_year[0].page_content[:1500]
    return cand[0].page_content[:1500]

# ── 工具2：get_latest_news（對齊原始：篩選 type=news，格式化輸出）
def rank_news_for_query(q: str, n: int = 6) -> List[Document]:
    toks = [t for t in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9]+", q.lower()) if t]
    news_docs = [d for d in all_docs if d.metadata.get("type") == "news"]
    if not toks: return sorted(news_docs, key=lambda x: x.metadata.get("date",""), reverse=True)[:n]
    def score_doc(d):
        text = (d.metadata.get("title","") + " " + d.page_content).lower()
        return (sum(text.count(t) for t in toks), d.metadata.get("date",""))
    ranked = sorted(news_docs, key=score_doc, reverse=True)
    seen, out = set(), []
    for d in ranked:
        if sum((d.page_content + d.metadata.get("title","")).lower().count(t) for t in toks) > 0:
            t = d.metadata.get("title","")
            if t not in seen:
                seen.add(t)
                out.append(d)
                if len(out) == n: break
    return out

def latest_news_snippets(n: int = 6) -> List[Document]:
    news_docs = [d for d in all_docs if d.metadata.get("type") == "news"]
    seen, out = set(), []
    for d in sorted(news_docs, key=lambda x: x.metadata.get("date",""), reverse=True):
        t = d.metadata.get("title","")
        if t not in seen:
            seen.add(t)
            out.append(d)
            if len(out) == n: break
    return out

def tool_get_latest_news(keyword: str = "") -> str:
    """對齊原始：篩選 news 類文件，格式化輸出日期+標題+內文"""
    docs = rank_news_for_query(keyword, n=6) if keyword else latest_news_snippets(n=6)
    out_lines = []
    for d in docs:
        t  = d.metadata.get("title","")
        dt = d.metadata.get("date","未註明日期")
        content_preview = unquote(d.page_content[:800])
        out_lines.append(f"【日期】：{dt}\n【標題】：{t}\n【公告與附件內容摘要】：\n{content_preview}\n")
    return "\n---\n".join(out_lines) if out_lines else "查無最新消息。"

# ── 工具3：search_regulations_and_general（對齊原始：用完整 retrieve_and_rerank）
def tool_search_database(search_query: str) -> str:
    hits = retrieve_and_rerank(search_query, top_k=6)
    if hits: return build_context_snippets(hits)
    return "查無相關資訊。"

# ── 工具4：record_correction（對齊原始）─────────────────────
def tool_record_correction(original_query: str, correction_info: str) -> str:
    return f"已記錄糾正資訊：{correction_info}。請使用這筆新資訊重新回答。"

# ── 工具5：get_competition_records（對齊原始：精確篩選 type=grade，民國/西元雙軌）
def tool_get_competition_records(keyword: str = "", year: str = "", name: str = "") -> str:
    grade_docs = [d for d in all_docs if d.metadata.get("type") == "grade"]

    # 民國/西元年份雙軌
    year_str = str(year).strip()
    roc_year, ad_year = "", ""
    if year_str.isdigit():
        y_int = int(year_str)
        if y_int > 1911:
            ad_year  = str(y_int)
            roc_year = str(y_int - 1911)
        else:
            roc_year = str(y_int)
            ad_year  = str(y_int + 1911)

    matched = []
    for d in grade_docs:
        text = d.page_content
        if keyword and keyword not in text: continue
        if name and name not in text: continue
        if year_str:
            if not ((roc_year and roc_year in text) or (ad_year and ad_year in text)):
                continue
        matched.append(text)

    if not matched:
        return f"查無符合條件的競賽成績 (關鍵字:{keyword}, 年份:{year}, 姓名:{name})。"

    limit = 25
    res_text = "\n".join(matched[:limit])
    if len(matched) > limit:
        return f"找到 {len(matched)} 筆成績（顯示前 {limit} 筆）：\n{res_text}"
    return f"找到 {len(matched)} 筆成績紀錄：\n{res_text}"

# ══════════════════════════════════════════════════════════════
# Agentic RAG — System Prompt + Tools 完全對齊原始系統
# ══════════════════════════════════════════════════════════════
SYSTEM_STYLE = (
    "你是一個隸屬於國立臺北大學（NTPU）體育室的自主 AI 助理（Autonomous AI Assistant）。\n"
    "NTPU 代表國立臺北大學。你可以使用多種工具來查詢法規、課表、最新消息、代表隊資訊與常見問題。\n\n"
    "【重要限制】\n"
    "你只能回答以下範疇的問題：\n"
    "- 國立臺北大學體育室相關業務（場地借用、課程、活動、法規、公告、代表隊等）\n"
    "- 體育、運動、健身相關的一般知識\n"
    "如果使用者的問題與上述範疇無關，請禮貌地拒絕，回應格式固定為：\n"
    "『您好，我是 NTPU 體育室助理，目前只能協助體育室相關問題。』\n\n"
    "【跨語系檢索準則】\n"
    "系統知識庫全為繁體中文。當使用者以其他語言提問時，必須先在心中將關鍵字翻譯成繁體中文再發動檢索。\n\n"
    "【重要行為準則】\n"
    "1. 你必須依賴檢索到的 context 來回答。如果真的找不到，請誠實說不知道。\n"
    "2. 請使用清晰的條列式重點與 Markdown 語法來排版你的回應。\n"
    "3. 如有連結需要呈現，必須使用 Markdown 語法 [標題文字](URL) 格式。\n"
    "4. 回答結尾不要加入空泛的客服式延伸話術。\n"
    "5. 若使用者要求超出系統能力範圍的操作，請提供目前可做的替代方案。\n"
)

TOOLS = [
    {"type":"function","name":"get_latest_news",
     "description":"當使用者詢問最新消息、公告、通知、系際盃活動、比賽報名等時呼叫此工具。",
     "parameters":{"type":"object","properties":{"keyword":{"type":"string","description":"要過濾的新聞關鍵字，若無則留空"}}}},
    {"type":"function","name":"get_schedule",
     "description":"當使用者詢問體育課表、課程表時呼叫此工具。",
     "parameters":{"type":"object","properties":{"year":{"type":"integer","description":"西元學年度，例如 2023，若未指定則留空"}}}},
    {"type":"function","name":"get_competition_records",
     "description":"當使用者查詢「競賽成績、比賽名次、特定年份賽事、特定選手成績」時，必須優先呼叫此工具進行精確比對。",
     "parameters":{"type":"object","properties":{
         "keyword":{"type":"string","description":"運動項目或賽事名稱，如: 游泳, 全大運。若無則留空"},
         "year":{"type":"string","description":"學年度，例如: 112。若無則留空"},
         "name":{"type":"string","description":"選手姓名，例如: 黃子嫣。若無則留空"}}}},
    {"type":"function","name":"search_regulations_and_general",
     "description":"檢索體育室所有相關資訊，包含：場地借用辦法、管理法規、代表隊教練與訓練時間、場地開放時間、聯絡資訊、師資介紹、常見問題等一般查詢。",
     "parameters":{"type":"object","properties":{"search_query":{"type":"string","description":"搜尋關鍵字"}},"required":["search_query"]}},
    {"type":"function","name":"record_correction",
     "description":"當使用者糾正系統的錯誤，或主動提供新的正確資訊時，必須呼叫此工具將正確資訊永久寫入系統庫。",
     "parameters":{"type":"object","properties":{
         "original_query":{"type":"string"},"correction_info":{"type":"string"}},
         "required":["original_query","correction_info"]}},
]

def get_agentic_answer(question: str) -> str:
    q_norm = roc_to_ad_year(question)
    system_prompt = SYSTEM_STYLE + "\n\n【輸出語系】請以繁體中文回答。"
    input_messages = [{"role":"system","content":system_prompt},{"role":"user","content":q_norm}]
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
                fn   = tc.name
                print(f"  [工具呼叫] {fn}({args})")

                # 路由邏輯完全對齊原始系統
                if fn == "get_schedule":
                    ctx = tool_get_schedule(args.get("year"))
                elif fn == "get_latest_news":
                    ctx = tool_get_latest_news(args.get("keyword",""))
                elif fn == "search_regulations_and_general":
                    ctx = tool_search_database(args.get("search_query", q_norm))
                elif fn == "get_competition_records":
                    ctx = tool_get_competition_records(
                        keyword=args.get("keyword",""),
                        year=args.get("year",""),
                        name=args.get("name",""))
                elif fn == "record_correction":
                    ctx = tool_record_correction(
                        args.get("original_query",""), args.get("correction_info",""))
                else:
                    ctx = "未知工具或查無資訊。"

                input_messages.append({
                    "type": "function_call_output",
                    "call_id": tc.call_id,
                    "output": ctx or "查無資料"
                })

        except Exception as e:
            print(f"  [Agent 錯誤] {e}"); break

    return answer

# ══════════════════════════════════════════════════════════════
# Advanced RAG（Pre+Retrieval+Post，無 Agent，同一生成模型）
# ══════════════════════════════════════════════════════════════
SYSTEM_PROMPT_ADVANCED = (
    "你是國立臺北大學體育室（OPE）的智能助理。"
    "只能回答體育室相關業務與體育運動一般知識。請使用繁體中文回答。"
    "你必須依賴提供的 Context 來回答，不可自行捏造。找不到答案請說查無相關資訊。"
)

def get_advanced_answer(question: str) -> str:
    # Pre-Retrieval + Retrieval + Post-Retrieval（用相同的 retrieve_and_rerank）
    hits        = retrieve_and_rerank(question, top_k=6)
    context_str = build_context_snippets(hits) if hits else "查無相關資訊。"
    messages = [
        {"role":"system","content":SYSTEM_PROMPT_ADVANCED},
        {"role":"user","content":f"以下是從知識庫檢索到的相關資訊：\n\n{context_str}\n\n根據以上資訊，請回答：{question}"}
    ]
    try:
        rsp = client.chat.completions.create(
            model=MODEL_AGENT, temperature=0.1, max_completion_tokens=1500, messages=messages)
        return rsp.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [Advanced RAG 錯誤] {e}")
        return "很抱歉，目前無法找到相關資訊。"

# ── 主程式 ────────────────────────────────────────────────────
def main():
    with open(QUESTIONS_PATH, "r", encoding="utf-8") as f:
        questions = json.load(f)

    # ── Agentic RAG ──────────────────────────────────────────
    # print(f"\n[Agentic RAG] 共 {len(questions)} 題...\n")
    # agentic_results = []
    # for i, q in enumerate(questions, 1):
    #     question = q["question"]
    #     print(f"  [{i:03d}/{len(questions)}] {question[:45]}...")
    #     answer   = clean_answer(get_agentic_answer(question))
    #     contexts = [d.page_content[:800] for d in retrieve_and_rerank(question, top_k=6)]
    #     agentic_results.append({"id":q["id"],"question":question,"answer":answer,
    #                              "contexts":contexts,"category":q.get("category","")})
    #     time.sleep(1.5)
    # out = os.path.join(OUTPUT_DIR, "agentic_results_3.json")
    # with open(out, "w", encoding="utf-8") as f:
    #     json.dump(agentic_results, f, ensure_ascii=False, indent=2)
    # answered = sum(1 for r in agentic_results if r["answer"] and "無法找到" not in r["answer"])
    # print(f"\n[完成] Agentic RAG：{answered}/{len(questions)} 題 → {out}")

    # ── Advanced RAG ─────────────────────────────────────────
    print(f"\n[Advanced RAG] 共 {len(questions)} 題...\n")
    advanced_results = []
    for i, q in enumerate(questions, 1):
        question = q["question"]
        print(f"  [{i:03d}/{len(questions)}] {question[:45]}...")
        answer   = clean_answer(get_advanced_answer(question))
        hits     = retrieve_and_rerank(question, top_k=6)
        contexts = [d.page_content[:800] for d in hits]
        advanced_results.append({"id":q["id"],"question":question,"answer":answer,
                                  "contexts":contexts,"category":q.get("category","")})
        time.sleep(1.5)
    out = os.path.join(OUTPUT_DIR, "advanced_results_3.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(advanced_results, f, ensure_ascii=False, indent=2)
    answered = sum(1 for r in advanced_results if r["answer"] and "無法找到" not in r["answer"])
    print(f"\n[完成] Advanced RAG：{answered}/{len(questions)} 題 → {out}")
    print("\n[下一步] conda activate ragas_env && python evaluate\\ragas_eval.py --judge gemma3")

if __name__ == "__main__":
    main()