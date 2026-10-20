"""由 MCP 收錄的官網原文出題（2026-10-21 起取代網路爬蟲轉成的 FAQ 題目）。

    python3 evaluate/benchmark/generate_official.py --export     # 1. 從 D1 匯出各單位官網內容到 cache/official_sources.json
    python3 evaluate/benchmark/generate_official.py              # 2. 出題，寫入 official.jsonl（可中斷後續跑）
    python3 evaluate/benchmark/build_seed.py                     # 3. 合併成 benchmark.jsonl

每題附「原文依據」（quote），程式會確認 quote 逐字出現在來源原文裡，找不到就捨棄，
所以標準答案都有官方原文支持；官方來源是該頁網址，資料日期是來源修訂日期（沒有就用系統最後確認日期）。
題目只用於評估，不放進系統（見 README）。所有題目 reviewed=false。
"""
import argparse
import hashlib
import json
import os
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
os.chdir(ROOT)
os.environ["NTPU_SKIP_INDEX_BUILD"] = "1"

import build_seed  # noqa: E402

CACHE = os.path.join(HERE, "cache", "official_sources.json")
OUT = os.path.join(HERE, "official.jsonl")
MCP_DIR = os.path.expanduser("~/ntpu-ai-assistant-mcp/mcp")

# AIA 單位代碼 → MCP 的 source_unit
MCP_UNIT = {
    "oaa": "oaa", "osa": "osa", "hr": "op", "oga": "oga", "ord": "ord", "oa": "oa", "lib": "library", "cic": "cic",
    "oia": "oia", "eec": "eec", "alu": "alumni", "sus": "sustainable", "edusp": "edusp", "os": "os",
    "vpa": "vice-president-academic", "vpad": "vice-president-administration", "vpf": "vice-president-financial",
    "pres": "president", "ope": "ope", "ge": "cge", "lc": "lc", "cob": "business", "mis": "mis", "dba": "dba",
    "coop": "coop", "acc": "acc", "stat": "stat", "lsm": "lsm", "giib": "giib", "dma": "dma",
}
CHUNK = 3000          # 一次給模型的原文字數
PER_CHUNK = 3         # 每段出幾題
NEWS_DAYS = 400       # 公告只取近 400 天（時效性較高的程序、期限題）


def d1(sql: str) -> list:
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ntpu-aia-canonical", "--remote", "--env", "production",
         "--config", "wrangler.ingest.jsonc", "--json", "--command", sql],
        cwd=MCP_DIR, capture_output=True, text=True, timeout=300,
    )
    if out.returncode != 0:
        raise SystemExit(f"D1 查詢失敗：{(out.stderr or out.stdout)[-600:]}")
    return json.loads(out.stdout)[0]["results"]


def export():
    data = {}
    for dept, unit in MCP_UNIT.items():
        rows = d1(
            "SELECT entity_type t, title, source_url u, substr(json_extract(payload_json,'$.bodyText'),1,20000) body, "
            "json_extract(payload_json,'$.updatedAt') upd, json_extract(payload_json,'$.sourceDate') sdate, "
            "json_extract(payload_json,'$.publishedAt') pub, json_extract(payload_json,'$.hasFullText') has_full, "
            "verified_at v FROM entities WHERE status='active' AND source_unit='" + unit + "' AND ("
            "entity_type='page' OR (entity_type='regulation' AND json_extract(payload_json,'$.hasFullText')=1) OR "
            f"(entity_type='announcement' AND published_at >= date('now','-{NEWS_DAYS} days')))"
        )
        docs = []
        for r in rows:
            body = (r.get("body") or "").strip()
            if len(body) < 120:
                continue
            date = (r.get("upd") or r.get("sdate") or r.get("pub") or r.get("v") or "")[:10]
            docs.append({"type": r["t"], "title": r["title"], "url": r["u"], "body": body, "date": date})
        data[dept] = docs
        print(f"{dept}: {len(docs)} 份")
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(data, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)


SYSTEM = """你是國立臺北大學校務問答系統的出題員。根據使用者提供的一段官網原文，出學生、教職員或校外人士實際會問的問題。
規則：
- 題目是自然問句，要寫出單位或情境（例如「圖書館」「資管所」「研究生」），不要出「這段文字說什麼」之類的考題，也不要出原文沒有答案的題目。
- 句型要有變化；盡量包含程序、資格、期限、金額、聯絡方式等具體資訊。
- standard_answer 只能根據原文，寫出關鍵事實（數字、條件、期限、地點、聯絡方式），不得加入原文沒有的內容。
- quote 是支持答案的一段原文，必須逐字複製原文中連續的 10～80 個字，不可改寫。
- 原文是檔案清單時，只出「某某表單或文件在哪裡下載」這類使用者會問的題目，題目不要出現「檔案庫」三個字。
- 原文是連結清單或內容不足以出題時，回傳空陣列。
只輸出 JSON：{"items":[{"question":"…","standard_answer":"…","quote":"…"}]}"""


def h8(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()[:8]


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def targets(existing: Counter) -> dict:
    """每單位要由官網原文出幾題原始題：總目標的 70%（其餘由改寫、追問補），扣掉已有的原始題。"""
    out = {}
    for dept in MCP_UNIT:
        goal = build_seed.TARGET_CORE if dept in build_seed.CORE_DEPTS else build_seed.TARGET_PER_DEPT
        out[dept] = max(0, round(goal * 0.7) - existing.get(dept, 0))
    return out


def load_done() -> list:
    return [json.loads(line) for line in open(OUT, encoding="utf-8")] if os.path.exists(OUT) else []


def chunks(doc):
    body = doc["body"]
    for start in range(0, min(len(body), CHUNK * 4), CHUNK):
        piece = body[start:start + CHUNK]
        if len(piece) >= 120:
            yield start, piece


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--only", help="只出這些單位（逗號分隔）")
    ap.add_argument("--extra", default="", help="額外加出的原始題數，例如 lib=30,giib=10（內容少的單位會放寬公告比例）")
    opts = ap.parse_args()
    if opts.export:
        export()
        return
    import agentic_v2_5_4high  # noqa: F401  載入 config.txt
    import llm_adapter

    data = json.load(open(CACHE, encoding="utf-8"))
    done = load_done()
    seed = [i for i in build_seed.collect_seed() if i["answerable"]]
    regs = [r for r in build_seed.load_generated() if r["origin"].startswith("generated:regulation")]
    existing = Counter(i["dept"] for i in seed + regs) + Counter(i["dept"] for i in done if i["type"] != "skip")
    need = targets(existing)
    extra = {k: int(v) for k, v in (x.split("=") for x in opts.extra.split(",") if x)}
    for dept, n in extra.items():
        need[dept] = need.get(dept, 0) + n
    used = {i["origin"] for i in done}
    rng = random.Random(21)
    for dept, n in need.items():
        if opts.only and dept not in opts.only.split(","):
            continue
        docs = list(data.get(dept) or [])
        # 內容頁與法規優先，公告最多三成；處室檔案庫（檔名清單）最後、最多兩成，避免題目多是「檔案庫有沒有某某表」
        rng.shuffle(docs)
        is_files = lambda d: d["title"].startswith("檔案庫")  # noqa: E731
        docs.sort(key=lambda d: (is_files(d), {"page": 0, "regulation": 0, "announcement": 1}[d["type"]]))
        made = 0
        news_cap = n if dept in extra else max(1, round(n * 0.3))
        files_cap = max(1, round(n * 0.2))
        news_made = files_made = 0
        for doc in docs:
            if made >= n:
                break
            if doc["type"] == "announcement" and news_made >= news_cap:
                continue
            if is_files(doc) and files_made >= files_cap:
                continue
            for start, piece in chunks(doc):
                if made >= n:
                    break
                origin = f"generated:official:{dept}:{doc['url']}#{start}"
                if origin in used:
                    continue
                try:
                    raw = llm_adapter.complete(
                        [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": f"單位：{build_seed.DEPT_NAMES.get(dept, dept)}\n標題：{doc['title']}\n"
                                                     f"原文：\n{piece}\n\n請出最多 {min(PER_CHUNK, n - made)} 題。"}],
                        model=llm_adapter.MODEL_BIG, response_format={"type": "json_object"})
                    items = json.loads(raw or "{}").get("items") or []
                except Exception as exc:  # noqa: BLE001 - 單段失敗就跳過
                    print(f"[略過] {dept} {doc['title'][:20]}：{type(exc).__name__}")
                    items = []
                rows, src = [], norm(piece)
                for k, it in enumerate(items):
                    q, a, quote = (str(it.get(x) or "").strip() for x in ("question", "standard_answer", "quote"))
                    if not (q and a and len(norm(quote)) >= 8 and norm(quote) in src):
                        continue  # 原文依據對不上：不收
                    rows.append(build_seed.item(
                        id=f"OFF-{dept.upper()}-{h8(origin)}-{k + 1}", dept=dept,
                        type=build_seed.type_of(q), question=q, standard_answer=a,
                        official_source={"name": doc["title"], "url": doc["url"]}, source_date=doc["date"],
                        risk_level=build_seed.risk_of(q, a), origin=origin, evidence_quote=quote,
                        source_kind=doc["type"]))
                if not rows:
                    rows = [build_seed.item(id=f"SKIP-{h8(origin)}", origin=origin, type="skip")]
                with open(OUT, "a", encoding="utf-8") as fh:
                    for r in rows:
                        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
                good = [r for r in rows if r["type"] != "skip"]
                made += len(good)
                if doc["type"] == "announcement":
                    news_made += len(good)
                if is_files(doc):
                    files_made += len(good)
        print(f"{dept}: 新增 {made}/{n}")


if __name__ == "__main__":
    main()
