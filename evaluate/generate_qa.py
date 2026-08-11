# -*- coding: utf-8 -*-
# generate_qa.py — 從 GE/LC 知識庫自動生成 QA 集，輸出 test_questions_v4.json
# 用法（在 NTPUOPE_v2/ 目錄下）：
#   .venv\Scripts\python.exe -X utf8 evaluate\generate_qa.py [--llm-extra] [--target-ge N] [--target-lc N]

import os, sys, re, json, argparse
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = BASE.parent / "crawler_data"
OUT  = BASE / "evaluate" / "test_questions_v4.json"

# 讀 config.txt（與 agentic_v2_5_4high.py 相同邏輯）
_cfg = BASE / "config.txt"
if _cfg.exists():
    for _line in _cfg.read_text(encoding="utf-8").splitlines():
        if "=" in _line and not _line.strip().startswith("#"):
            _k, _v = _line.strip().split("=", 1)
            os.environ[_k.strip()] = _v.strip()

# ──────────────────────────────────────────────────────────────
# 拒絕收錄模糊答案的關鍵詞
# ──────────────────────────────────────────────────────────────
VAGUE_PHRASES = [
    "請查詢", "依各系規定", "依規定", "詳見", "另行公告",
    "可以參考", "可至官網", "請洽", "在辦法中有詳細", "詳細規定",
    "具體條件", "相關規定", "請確認", "需查詢", "公告中未提供",
    "具體內容可參考", "可以在官方", "依規定辦理",
]

def _is_vague(text: str) -> bool:
    t = text.strip()
    if len(t) < 25:
        return True
    for p in VAGUE_PHRASES:
        if p in t:
            return True
    return False


# ──────────────────────────────────────────────────────────────
# 1. GE FAQ 直接解析（### 類別Q數字 問題文字）
# ──────────────────────────────────────────────────────────────
GE_QA_RE = re.compile(r'^### (.+?Q\d+)\s+(.+)')

def parse_ge_faq(md_path: Path) -> list[dict]:
    text = md_path.read_text(encoding="utf-8")
    faq_start = text.find("# 常見問題")
    if faq_start == -1:
        return []
    next_h1 = text.find("\n# ", faq_start + 10)
    faq_text = text[faq_start:next_h1] if next_h1 != -1 else text[faq_start:]

    entries, current_q, current_cat, answer_lines = [], None, "", []

    def flush():
        if current_q and answer_lines:
            ans = "\n".join(answer_lines).strip()
            if ans and not _is_vague(ans):
                entries.append({"question": current_q, "answer": ans, "cat_raw": current_cat})

    for line in faq_text.splitlines():
        m = GE_QA_RE.match(line)
        if m:
            flush()
            cat_num, question = m.group(1).strip(), m.group(2).strip()
            cn_m = re.match(r'^(.+?)(Q\d+)$', cat_num)
            current_cat = cn_m.group(1).strip() if cn_m else cat_num
            current_q, answer_lines = question, []
        elif current_q is not None:
            answer_lines.append(line)
    flush()
    return entries


# ──────────────────────────────────────────────────────────────
# 2. LC FAQ 直接解析（### 問題文字，無編號）
# ──────────────────────────────────────────────────────────────
def parse_lc_faq(md_path: Path) -> list[dict]:
    text = md_path.read_text(encoding="utf-8")
    faq_start = text.find("# 常見問題")
    if faq_start == -1:
        return []
    next_h1 = text.find("\n# ", faq_start + 10)
    faq_text = text[faq_start:next_h1] if next_h1 != -1 else text[faq_start:]

    entries, current_q, answer_lines = [], None, []

    def flush():
        if current_q and answer_lines:
            ans = "\n".join(answer_lines).strip()
            if ans and not _is_vague(ans):
                entries.append({"question": current_q, "answer": ans})

    for line in faq_text.splitlines():
        if line.startswith("### "):
            flush()
            current_q, answer_lines = line[4:].strip(), []
        elif current_q is not None:
            answer_lines.append(line)
    flush()
    return entries


# ──────────────────────────────────────────────────────────────
# 3. GE 法規條文解析（抵免辦法 + 課程實施辦法）
# ──────────────────────────────────────────────────────────────
GE_REG_TITLES = [
    "國立臺北大學通識教育中心學生抵免學分辦法",
    "國立臺北大學通識教育課程實施辦法",
    "國立臺北大學通識微型及自主學習課程實施原則",
]

def parse_ge_regulations(md_path: Path) -> list[str]:
    """回傳各法規的全文段落（list of str），每份法規一個元素"""
    text = md_path.read_text(encoding="utf-8")
    reg_start = text.find("# 相關法規")
    if reg_start == -1:
        return []
    reg_text = text[reg_start:]

    results = []
    for title in GE_REG_TITLES:
        marker = f"## {title}"
        start = reg_text.find(marker)
        if start == -1:
            continue
        # 找下一個 ## 或 # 結束
        next_marker = re.search(r'\n## |\n# ', reg_text[start + len(marker):])
        end = start + len(marker) + next_marker.start() if next_marker else len(reg_text)
        chunk = reg_text[start:end].strip()
        # 去掉 ### Page N 行
        chunk = re.sub(r'### Page \d+\n?', '', chunk)
        if len(chunk) > 200:
            results.append((title.replace("國立臺北大學", ""), chunk))
    return results


# ──────────────────────────────────────────────────────────────
# 4. LC 最新消息分切（每則公告一個段落）
# ──────────────────────────────────────────────────────────────
def parse_lc_news_items(md_path: Path, min_chars: int = 300) -> list[tuple[str, str]]:
    """回傳 (date_str, content) list，只保留內容夠長的公告"""
    text = md_path.read_text(encoding="utf-8")
    news_start = text.find("# 最新消息")
    news_end   = text.find("\n# ", news_start + 10)
    news_text  = text[news_start:news_end] if news_end != -1 else text[news_start:]

    DATE_RE = re.compile(r'^## (\d{4} / \d{2} / \d{2})')
    items, current_date, current_lines = [], None, []

    def flush():
        if current_date and current_lines:
            content = "\n".join(current_lines).strip()
            # 只保留「公告內容:」後的文字
            ci = content.find("### 公告內容:")
            if ci != -1:
                content = content[ci + len("### 公告內容:"):].strip()
            # 去掉 **[...]** 超連結行（只有連結的行）
            content = re.sub(r'^\*\*\[.+?\]\(.+?\)\*\*\s*$', '', content, flags=re.MULTILINE)
            content = re.sub(r'^https?://\S+\s*$', '', content, flags=re.MULTILINE)
            content = re.sub(r'\n{3,}', '\n\n', content).strip()
            if len(content) >= min_chars:
                items.append((current_date, content[:3000]))  # 最多 3000 字

    for line in news_text.splitlines():
        m = DATE_RE.match(line)
        if m:
            flush()
            current_date, current_lines = m.group(1), []
        elif current_date is not None:
            current_lines.append(line)
    flush()
    return items


# ──────────────────────────────────────────────────────────────
# 5. GE 最新消息分切
# ──────────────────────────────────────────────────────────────
def parse_ge_news_items(md_path: Path, min_chars: int = 250) -> list[tuple[str, str]]:
    text = md_path.read_text(encoding="utf-8")
    news_start = text.find("# 最新消息")
    news_end   = text.find("\n# 表單下載")
    news_text  = text[news_start:news_end] if news_end != -1 else text[news_start:]

    DATE_RE = re.compile(r'^## (\d{4} / \d{2} / \d{2})')
    items, current_date, current_lines = [], None, []

    def flush():
        if current_date and current_lines:
            content = "\n".join(current_lines).strip()
            content = re.sub(r'^\*\*\[.+?\]\(.+?\)\*\*\s*$', '', content, flags=re.MULTILINE)
            content = re.sub(r'^https?://\S+\s*$', '', content, flags=re.MULTILINE)
            content = re.sub(r'\n{3,}', '\n\n', content).strip()
            if len(content) >= min_chars:
                items.append((current_date, content[:2000]))

    for line in news_text.splitlines():
        m = DATE_RE.match(line)
        if m:
            flush()
            current_date, current_lines = m.group(1), []
        elif current_date is not None:
            current_lines.append(line)
    flush()
    return items


# ──────────────────────────────────────────────────────────────
# 6. LLM 生成（強版提示詞）
# ──────────────────────────────────────────────────────────────
STRICT_PROMPT = """你是一位大學行政服務測試題目設計師。請根據下方文字，生成 {n} 個學生可能會問的問題與正確答案（ground_truth）。

【嚴格規定】
- 只在文字中有「直接、具體的事實答案」時才出題，例如：
  具體數字、分數門檻、申請流程步驟、截止日期、地點、聯絡方式、資格條件
- 禁止出答案是以下類型的題目（直接跳過）：
  「請查詢官網」、「依各系規定」、「詳見辦法」、「另行公告」、「可以聯繫相關人員」
- ground_truth 必須是完整的事實性句子，讀者看完不需要再查其他資料
- 問題要像真實學生會問的，不要像考試題

輸出格式（JSON 陣列，不含任何其他說明）：
[{{"question":"...","ground_truth":"..."}}]

文字：
{text}"""

PARAPHRASE_PROMPT = """以下是一個大學行政服務的問答對。
請為這個問題產生 {n} 種不同的問法（改變措辭、語氣、角度，但意思相同），ground_truth 保持完全不變。

要求：
- 有些可以更口語（「怎麼辦理？」→「要怎麼辦？」「流程是什麼？」）
- 有些可以從學生角度出發（「我是轉學生，想請問...」「如果我...，需要怎麼做？」）
- 有些可以更精簡（去掉問號前的說明，只留核心關鍵詞）
- 不要產生問法完全一樣或意思明顯不同的題目

輸出格式（JSON 陣列，不含任何說明）：
[{{"question":"...","ground_truth":{gt_json}}}]

原始問答：
問題：{question}
答案：{ground_truth}"""

def llm_paraphrase(qa_pairs: list[dict], dept: str,
                   n_per_question: int = 2) -> list[dict]:
    """對現有問答對生成不同問法版本"""
    try:
        from openai import OpenAI
        c = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
    except ImportError:
        print("[LLM] openai 未安裝", file=sys.stderr); return []

    results = []
    for item in qa_pairs:
        q  = item.get("question", "").strip()
        gt = item.get("ground_truth") or item.get("answer", "")
        gt = gt.strip()
        if not q or not gt:
            continue
        gt_json = json.dumps(gt, ensure_ascii=False)
        prompt = PARAPHRASE_PROMPT.format(
            n=n_per_question, question=q,
            ground_truth=gt[:500], gt_json=gt_json
        )
        try:
            resp = c.chat.completions.create(
                model="gpt-4o-mini", temperature=0.5, max_tokens=1500,
                messages=[{"role": "user", "content": prompt}]
            )
            raw = resp.choices[0].message.content.strip()
            m = re.search(r'\[.*\]', raw, re.DOTALL)
            if not m:
                continue
            pairs = json.loads(m.group())
            for p in pairs:
                if not isinstance(p, dict):
                    continue
                nq = (p.get("question") or "").strip()
                ngt = (p.get("ground_truth") or gt).strip()
                if nq and nq != q and not _is_vague(ngt):
                    results.append({"question": nq, "ground_truth": ngt,
                                     "label": "改寫", "dept": dept})
        except Exception as e:
            print(f"[LLM] 改寫失敗：{e}", file=sys.stderr)
    return results


def llm_generate_strict(passages: list[tuple[str, str]], dept: str,
                         n_per_passage: int = 3) -> list[dict]:
    try:
        from openai import OpenAI
        c = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
    except ImportError:
        print("[LLM] openai 未安裝", file=sys.stderr); return []

    results = []
    for label, text in passages:
        prompt = STRICT_PROMPT.format(n=n_per_passage, text=text[:2500])
        try:
            resp = c.chat.completions.create(
                model="gpt-4o-mini", temperature=0.2, max_tokens=2000,
                messages=[{"role": "user", "content": prompt}]
            )
            raw = resp.choices[0].message.content.strip()
            m = re.search(r'\[.*\]', raw, re.DOTALL)
            if not m:
                continue
            pairs = json.loads(m.group())
            for p in pairs:
                if not isinstance(p, dict):
                    continue
                q = (p.get("question") or "").strip()
                gt = (p.get("ground_truth") or "").strip()
                if q and gt and not _is_vague(gt):
                    results.append({"question": q, "ground_truth": gt,
                                     "label": label, "dept": dept})
        except Exception as e:
            print(f"[LLM] {label[:30]} 失敗：{e}", file=sys.stderr)
    return results


# ──────────────────────────────────────────────────────────────
# 7. 組合成最終 JSON
# ──────────────────────────────────────────────────────────────
def build_records(ge_faqs, lc_faqs, ge_reg_qa=None, ge_news_qa=None,
                  lc_news_qa=None, ge_para_qa=None, lc_para_qa=None,
                  existing: list = None) -> list[dict]:
    # 起始 ID 接在現有題目之後
    start = (max(int(r["id"].replace("V4","")) for r in existing) + 1) if existing else 1
    records = list(existing or [])
    counter = start

    def add(question, ground_truth, dept, category,
            expected_tool="tool_search_database"):
        nonlocal counter
        records.append({
            "id": f"V4{counter:03d}",
            "question": question,
            "category": category,
            "ground_truth": ground_truth,
            "expected_tool": expected_tool,
            "topic_adherent": True,
            "dept": dept,
        })
        counter += 1

    # 僅在非 append 模式下才加入基礎 FAQ（append 時已存在）
    if not existing:
        for e in ge_faqs:
            cat = (e.get("cat_raw") or "通識").replace("Q", "").strip() or "通識"
            add(e["question"], e["answer"], "ge", f"GE/FAQ/{cat}")
        for e in lc_faqs:
            add(e["question"], e["answer"], "lc", "LC/FAQ")

    for e in (ge_reg_qa or []):
        add(e["question"], e["ground_truth"], "ge", f"GE/法規/{e.get('label','')[:20]}")
    for e in (ge_news_qa or []):
        add(e["question"], e["ground_truth"], "ge", "GE/最新消息")
    for e in (lc_news_qa or []):
        add(e["question"], e["ground_truth"], "lc", "LC/最新消息")
    for e in (ge_para_qa or []):
        add(e["question"], e["ground_truth"], "ge", "GE/FAQ/改寫")
    for e in (lc_para_qa or []):
        add(e["question"], e["ground_truth"], "lc", "LC/FAQ/改寫")

    return records


# ──────────────────────────────────────────────────────────────
# 8. 主程式
# ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--llm-extra",   action="store_true", help="用 LLM 從法規與最新消息生成補充題目")
    parser.add_argument("--paraphrase",  action="store_true", help="對 FAQ 生成不同問法（需 --llm-extra）")
    parser.add_argument("--skip-regs",   action="store_true", help="--llm-extra 時跳過法規出題，只用最新消息")
    parser.add_argument("--news-offset", type=int, default=0,  help="GE 最新消息從第 N 則開始取樣（避免重複舊批）")
    parser.add_argument("--append",      action="store_true", help="追加至現有 v4，不覆蓋已有題目")
    parser.add_argument("--target-ge",   type=int, default=60,  help="GE 目標題數")
    parser.add_argument("--target-lc",   type=int, default=100, help="LC 目標題數")
    args = parser.parse_args()

    ge_path = DATA / "cge_content.md"
    lc_path = DATA / "lc_content.md"

    # 載入現有題目（append 模式）
    existing = None
    if args.append and OUT.exists():
        existing = json.load(open(OUT, encoding="utf-8"))
        from collections import Counter
        ec = Counter(r["dept"] for r in existing)
        print(f"[載入現有] {len(existing)} 題（GE:{ec.get('ge',0)} / LC:{ec.get('lc',0)}）")

    print("[GE] 解析 FAQ…")
    ge_faqs = parse_ge_faq(ge_path)
    print(f"  → {len(ge_faqs)} 題")

    print("[LC] 解析 FAQ…")
    lc_faqs = parse_lc_faq(lc_path)
    print(f"  → {len(lc_faqs)} 題")

    ge_reg_qa = ge_news_qa = lc_news_qa = []
    ge_para_qa = lc_para_qa = []

    if args.llm_extra:
        from collections import Counter as _C
        exist_c = _C(r["dept"] for r in (existing or []))
        ge_have = exist_c.get("ge", 0) if existing else len(ge_faqs)
        lc_have = exist_c.get("lc", 0) if existing else len(lc_faqs)

        # ── GE 法規 ──
        need_ge = max(0, args.target_ge - ge_have)
        if need_ge > 0 and not args.skip_regs:
            ge_regs = parse_ge_regulations(ge_path)
            print(f"[GE] 法規段落：{len(ge_regs)} 份，需補 {need_ge} 題…")
            n_per_reg = max(2, need_ge // max(len(ge_regs), 1))
            ge_reg_qa = llm_generate_strict(ge_regs, "ge", n_per_passage=n_per_reg)
            print(f"  → 法規補充 {len(ge_reg_qa)} 題")
        elif need_ge > 0 and args.skip_regs:
            print(f"[GE] 跳過法規出題（--skip-regs），需補 {need_ge} 題全部由最新消息提供")

        # ── GE 最新消息 ──
        still_need_ge = max(0, need_ge - len(ge_reg_qa))
        if still_need_ge > 0:
            ge_news = parse_ge_news_items(ge_path)
            batch = ge_news[args.news_offset:]
            print(f"[GE] 最新消息（offset={args.news_offset}）：{len(batch)} 則，需再補 {still_need_ge} 題…")
            n_news = max(1, (still_need_ge + len(batch) - 1) // max(len(batch), 1))
            ge_news_qa = llm_generate_strict(batch[:max(30, still_need_ge)], "ge", n_per_passage=n_news)
            print(f"  → 最新消息補充 {len(ge_news_qa)} 題")

        # ── LC 最新消息（全部 90 則）──
        need_lc = max(0, args.target_lc - lc_have)
        if need_lc > 0:
            lc_news = parse_lc_news_items(lc_path)
            print(f"[LC] 最新消息：{len(lc_news)} 則，需補 {need_lc} 題…")
            n_lc = max(1, min(3, need_lc // max(len(lc_news), 1)))
            lc_news_qa = llm_generate_strict(lc_news, "lc", n_per_passage=n_lc)
            print(f"  → LC 最新消息補充 {len(lc_news_qa)} 題")

        # ── 改寫問法 ──
        if args.paraphrase:
            print("[GE] 對 FAQ 生成改寫問法…")
            ge_para_qa = llm_paraphrase(ge_faqs, "ge", n_per_question=2)
            print(f"  → GE 改寫 {len(ge_para_qa)} 題")

            print("[LC] 對 FAQ 生成改寫問法…")
            lc_para_qa = llm_paraphrase(lc_faqs[:15], "lc", n_per_question=2)
            print(f"  → LC 改寫 {len(lc_para_qa)} 題")

    records = build_records(
        ge_faqs, lc_faqs,
        ge_reg_qa=ge_reg_qa, ge_news_qa=ge_news_qa,
        lc_news_qa=lc_news_qa,
        ge_para_qa=ge_para_qa, lc_para_qa=lc_para_qa,
        existing=existing,
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=1)

    from collections import Counter
    dist = Counter(r["dept"] for r in records)
    print(f"\n完成！共 {len(records)} 題 → {OUT}")
    print(f"  GE: {dist.get('ge',0)} 題 / LC: {dist.get('lc',0)} 題")
    if dist.get('ge', 0) < args.target_ge:
        print(f"  ⚠ GE 距目標 {args.target_ge} 題還差 {args.target_ge - dist.get('ge',0)} 題")
    if dist.get('lc', 0) < args.target_lc:
        print(f"  ⚠ LC 距目標 {args.target_lc} 題還差 {args.target_lc - dist.get('lc',0)} 題")


if __name__ == "__main__":
    main()
