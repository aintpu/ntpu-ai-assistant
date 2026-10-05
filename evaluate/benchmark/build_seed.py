"""NTPU AIA Benchmark 種子題庫：把現有的 FAQ 與歷次測試題轉成統一格式。

    python evaluate/benchmark/build_seed.py

輸出：
- evaluate/benchmark/benchmark.jsonl   每行一題（格式見 README.md）
- evaluate/benchmark/coverage.md       與目標（每處室 ≥30 題、核心處室 ≥100 題、題型比例）的差距

不呼叫任何模型、不連網路。改寫題、追問題與部分無答案題需要模型產生，屬於下一步。
"""
import ast
import json
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
DATA = os.path.join(ROOT, "crawler_data")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

from office_catalog import FAQ_OFFICES  # noqa: E402

DEPT_NAMES = {
    "ope": "體育室", "ge": "通識教育中心", "lc": "語言中心", "oaa": "教務處", "osa": "學務處",
    "hr": "人事室", "oga": "總務處", **{code: spec[0] for code, spec in FAQ_OFFICES.items()},
}
# 核心處室：學生與教職員詢問量最大的行政單位（目標每處室 ≥100 題）。可依實際詢問量調整。
CORE_DEPTS = ("oaa", "osa", "hr", "oga", "lib")
TARGET_PER_DEPT = 30
TARGET_CORE = 100
TARGET_TOTAL = 1000
# 老師建議的題型比例
TYPE_TARGETS = {"faq": 0.50, "paraphrase": 0.20, "procedure": 0.15, "followup": 0.05, "unanswerable": 0.10}
TYPE_NAMES = {"faq": "常見問題", "paraphrase": "口語化／改寫", "procedure": "程序、資格、期限",
              "followup": "追問", "unanswerable": "無答案／應拒答"}

FIELD_LABELS = ("FAQ 編號", "承辦組別", "業務主題", "資料來源", "來源網址", "來源日期", "維護類型", "回答類型",
                "適用對象", "聯絡窗口", "相關檔案網址", "關鍵字", "引用法源")
FIELD_START = ("FAQ 編號", "資料來源", "引用法源", "來源網址")
FIELD_RE = re.compile(r"^(" + "|".join(map(re.escape, FIELD_LABELS)) + r")：\s*(.*)$")

# 程序、資格、期限類（老師的第 3 類題型）
PROCEDURE_RE = re.compile(r"怎麼申請|如何申請|如何辦理|怎麼辦理|流程|程序|資格|條件|期限|截止|何時|什麼時候|幾天內|要準備|應繳|須檢附|步驟")
# 高風險：答錯會影響個人權益（學分、資格、期限、金錢、獎懲、學籍、差勤）
HIGH_RISK_RE = re.compile(
    r"學分|抵免|免修|畢業|資格|條件|期限|截止|逾期|罰|懲|退學|休學|復學|退費|學費|費用|金額|補助|獎學金|助學金|"
    r"貸款|薪|加班|工資|請假|事假|病假|特休|年資|保險|兵役|居留|簽證|工作證|成績|學籍|轉系|雙主修|輔系")
LOW_RISK_RE = re.compile(r"電話|地址|在哪|位置|聯絡|網址|網站|開放時間|是誰|成立|簡介|有哪些組|主任|首長")


def risk_of(question: str, answer: str) -> str:
    """只看問題本身：回答常順帶提到金額、期限等字眼，一併比對會把「首頁有哪些連結」也標成高風險。"""
    if HIGH_RISK_RE.search(question):
        return "high"
    if LOW_RISK_RE.search(question):
        return "low"
    return "medium"


def type_of(question: str) -> str:
    return "procedure" if PROCEDURE_RE.search(question) else "faq"


def parse_faq_markdown(path: str):
    """### 問題 / 回答段落 / 「欄位：值」行。回傳 [(question, answer, fields)]。"""
    text = open(path, encoding="utf-8").read()
    out = []
    for block in re.split(r"(?m)^### ", text)[1:]:
        lines = block.strip().splitlines()
        question = lines[0].strip()
        answer, fields = [], {}
        for line in lines[1:]:
            m = FIELD_RE.match(line.strip())
            # 欄位區從這幾個欄位開始；在那之前的「適用對象：…」等是回答內容（例如 EEC-MGT-005）
            if m and (fields or m.group(1) in FIELD_START):
                fields[m.group(1)] = m.group(2).strip()
            elif not fields and line.strip():
                answer.append(line.strip())
        if question and answer:
            out.append((question, "\n".join(answer), fields))
    return out


def item(**kw):
    base = {
        "id": "", "dept": "", "dept_name": "", "type": "faq", "question": "", "standard_answer": "",
        "official_source": {"name": "", "url": ""}, "source_date": "", "risk_level": "medium",
        "answerable": True, "origin": "", "reviewed": False,
    }
    base.update(kw)
    base["dept_name"] = DEPT_NAMES.get(base["dept"], "")
    return base


def from_faq_files():
    files = [(code, f"{code}_faq.md") for code in FAQ_OFFICES] + [("hr", "hr_content.md"), ("oga", "oga_content.md")]
    items = []
    for code, name in files:
        path = os.path.join(DATA, name)
        if not os.path.exists(path):
            continue
        for n, (q, a, f) in enumerate(parse_faq_markdown(path), 1):
            items.append(item(
                id=f.get("FAQ 編號") or f"{code.upper()}-SEED-{n:03d}",
                dept=code, type=type_of(q), question=q, standard_answer=a,
                official_source={"name": f.get("資料來源", ""), "url": f.get("來源網址", "")},
                source_date=f.get("來源日期", ""), risk_level=risk_of(q, a),
                origin=f"crawler_data/{name}",
            ))
    return items


def from_legacy_tests():
    """歷次評估題（體育室 v3、通識與語言中心 v4）：有標準答案，但沒有逐題官方來源與資料日期。"""
    items = []
    for name, default_dept in (("test_questions_v3.json", "ope"), ("test_questions_v4.json", None)):
        path = os.path.join(ROOT, "evaluate", name)
        for q in json.load(open(path, encoding="utf-8")):
            dept = q.get("dept") or default_dept
            items.append(item(
                id=f"LEGACY-{q['id']}", dept=dept, type=type_of(q["question"]), question=q["question"],
                standard_answer=str(q["ground_truth"]), risk_level=risk_of(q["question"], str(q["ground_truth"])),
                origin=f"evaluate/{name}",
            ))
    return items


def unanswerable_seeds():
    """應拒答：外校、與校務無關（取自 evaluate/scope_probe.py 的應擋題）；本校但資料沒有（取自 golden set）。"""
    tree = ast.parse(open(os.path.join(ROOT, "evaluate", "scope_probe.py"), encoding="utf-8").read())
    should_block = next(ast.literal_eval(node.value) for node in tree.body
                        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "SHOULD_BLOCK")
    items = [item(id=f"REFUSE-{n:03d}", dept="", type="unanswerable", question=q, answerable=False,
                  standard_answer="應拒答：不屬於國立臺北大學校務範圍。", risk_level="medium",
                  origin="evaluate/scope_probe.py")
             for n, q in enumerate(should_block, 1)]
    golden = json.load(open(os.path.join(ROOT, "evaluate", "mcp_records_golden.json"), encoding="utf-8"))
    for c in golden["cases"]:
        if c["expect"] is None:
            items.append(item(id=f"NODATA-{c['id']}", dept=c["dept"], type="unanswerable", question=c["question"],
                              answerable=False, standard_answer="應回答查無資料，並建議洽詢承辦單位；不得編造規定。",
                              origin="evaluate/mcp_records_golden.json"))
    return items


def coverage_report(items):
    by_dept = Counter(i["dept"] for i in items if i["dept"])
    types = Counter(i["type"] for i in items)
    risks = Counter(i["risk_level"] for i in items)
    total = len(items)
    lines = ["# NTPU AIA Benchmark 種子題庫覆蓋率", "",
             "由 `evaluate/benchmark/build_seed.py` 產生，請勿手動編輯。", "",
             f"總題數：**{total}**（目標約 {TARGET_TOTAL}）", "",
             "## 各單位題數", "", "| 單位 | 題數 | 目標 | 差距 |", "|---|---|---|---|"]
    for code in DEPT_NAMES:
        target = TARGET_CORE if code in CORE_DEPTS else TARGET_PER_DEPT
        n = by_dept.get(code, 0)
        gap = "達標" if n >= target else f"缺 {target - n}"
        core = "（核心）" if code in CORE_DEPTS else ""
        lines.append(f"| {DEPT_NAMES[code]}{core} | {n} | {target} | {gap} |")
    lines += ["", "## 題型比例", "", "| 題型 | 題數 | 目前比例 | 目標比例 |", "|---|---|---|---|"]
    for t, ratio in TYPE_TARGETS.items():
        lines.append(f"| {TYPE_NAMES[t]} | {types.get(t, 0)} | {types.get(t, 0) / total:.0%} | {ratio:.0%} |")
    lines += ["", "## 風險等級（自動標記，需人工抽查）", "", "| 等級 | 題數 |", "|---|---|"]
    for r, name in (("high", "高"), ("medium", "中"), ("low", "低")):
        lines.append(f"| {name} | {risks.get(r, 0)} |")
    no_source = sum(1 for i in items if i["answerable"] and not i["official_source"]["url"])
    lines += ["", "## 待補", "",
              f"- 口語化／改寫題、追問題：需用模型由現有題目產生（目前 0 題）。",
              f"- 教務處、學務處：沒有問答格式的資料，需由法規條文產生題目。",
              f"- 有 {no_source} 題缺官方來源網址（多為體育室、通識、語言中心的舊測試題）。",
              f"- 風險等級為關鍵字自動標記；所有題目 `reviewed=false`，尚未人工審核。"]
    return "\n".join(lines) + "\n"


def main():
    items = from_faq_files() + from_legacy_tests() + unanswerable_seeds()
    seen = Counter(i["id"] for i in items)
    dup = defaultdict(int)
    for i in items:  # 同一編號出現多次時加流水號，確保 id 唯一
        if seen[i["id"]] > 1:
            dup[i["id"]] += 1
            i["id"] = f"{i['id']}#{dup[i['id']]}"
    with open(os.path.join(OUT_DIR, "benchmark.jsonl"), "w", encoding="utf-8") as fh:
        for i in items:
            fh.write(json.dumps(i, ensure_ascii=False) + "\n")
    report = coverage_report(items)
    open(os.path.join(OUT_DIR, "coverage.md"), "w", encoding="utf-8").write(report)
    print(report)


if __name__ == "__main__":
    main()
