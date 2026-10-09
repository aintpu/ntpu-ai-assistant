"""範圍判斷誤擋檢查：用正式模型跑一批「沒寫單位名稱」的自然問法，列出被判成不在範圍的題目。

    python evaluate/scope_probe.py              # 需要 OPENAI_API_KEY（config.txt）
    python evaluate/scope_probe.py --repeat 3   # 每題跑 3 次，列出結果不一致的題目

SHOULD_ANSWER 都是本校業務、資料庫有可能有答案的問題，理想上都不該被擋；
SHOULD_BLOCK 是外校或與校務無關的問題，應該被擋。
"""
import os
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

SHOULD_ANSWER = [
    "我想問校慶在何時", "校慶是什麼時候", "校慶園遊會攤位怎麼申請", "運動會什麼時候",
    "畢業典禮在哪一天", "這學期什麼時候開學", "期中考是哪一週", "寒假從什麼時候開始",
    "學費什麼時候要繳", "繳費單去哪裡印", "可以分期付款繳學費嗎", "就學貸款怎麼辦",
    "抵免和免修有什麼不同", "學分抵免怎麼申請", "雙主修要怎麼申請", "輔系有學分上限嗎",
    "休學要怎麼辦", "我想復學", "成績單怎麼申請", "在學證明在哪裡申請",
    "宿舍什麼時候可以申請", "宿舍可以帶電器嗎", "獎學金有哪些", "清寒補助怎麼申請",
    "學生證掉了怎麼辦", "兵役緩徵要怎麼辦", "諮商要怎麼預約", "生病請假怎麼請",
    "機車停車證怎麼申請", "校園網路連不上", "學校信箱密碼忘了", "怎麼借書",
    "可以借討論室嗎", "交換學生怎麼申請", "國際生可以打工嗎", "英文畢業門檻是什麼",
    "多益考幾分可以抵英文", "通識要修幾學分", "教授的研究計畫補助", "怎麼報帳",
    "出差的差旅費怎麼核銷", "老師請假要找誰", "加班費怎麼算", "校友可以回來用圖書館嗎",
    "要捐款給學校怎麼做", "學校的永續報告書在哪", "健身房開放時間", "游泳池怎麼收費",
    "系際盃什麼時候報名", "最近有什麼活動", "最近有什麼講座", "有沒有徵才的公告",
    "現在的校長是誰", "學校電話幾號", "人在國外想捐款給學校怎麼匯", "失物招領在哪裡",
    # 2026-10-04 端到端評估發現：模型不知道這些是本校資料裡的名詞
    "北聯大計畫可以補助多少錢", "內控制度手冊去哪裡找最新版", "住信義會館有哪些規定",
    "內部稽核是誰在負責", "行天宮的急難救助怎麼申請", "全民國防教育法的內容", "用學校 VPN 有什麼要注意",
    # 2026-10-08 使用者回報：英文問校長被分到學務處、模型編出人名；問人名被擋
    "who is 林道通", "林道通是誰", "the president of NTPU?", "Who is the president of National Taipei University?",
    "who is the vice president of NTPU",
]
# 中英文同義問法：兩種問法應判到同一個處室（老師建議 一-1：中英文查詢意圖一致）
SAME_INTENT = [
    ("現任校長是誰", "Who is the president of NTPU?"),
    ("圖書館開放時間", "What are the library opening hours?"),
    ("怎麼申請宿舍", "How do I apply for a dormitory?"),
    ("學分抵免怎麼申請", "How do I apply for credit transfer?"),
    ("交換學生怎麼申請", "How can I apply to be an exchange student?"),
    ("校園網路連不上", "The campus Wi-Fi is not working"),
    ("事假可以請幾天", "How many days of personal leave can staff take?"),
    ("校友證怎麼辦", "How do I get an alumni card?"),
    ("學術副校長是誰", "Who is the vice president for academic affairs?"),
    ("研究倫理審查怎麼申請", "How do I apply for research ethics review?"),
]

SHOULD_BLOCK = [
    "台大的宿舍怎麼申請", "淡江大學的學費多少", "今天台北天氣如何", "推薦附近好吃的餐廳",
    "幫我寫一首詩", "比特幣會漲嗎", "台北市長是誰", "什麼是量子力學", "美國總統是誰",
    "推薦好看的電影", "政大的抵免規定", "台積電面試會問什麼", "台大的校長是誰", "NTU library hours",
]


def main():
    import agentic_v2_5_4high as core  # 載入 config.txt 與知識庫索引（用快取）

    repeat = int(sys.argv[sys.argv.index("--repeat") + 1]) if "--repeat" in sys.argv else 1
    if "--classifier-off" in sys.argv:
        # 比較用：不用 CLASSIFIER_MODEL（例如 Sonnet 5.5），改回 MODEL_SMALL
        import llm_adapter
        llm_adapter.classifier_client = None
    import llm_adapter as _la
    print(f"分類模型：{_la.CLASSIFIER_MODEL if _la.classifier_client else _la.MODEL_SMALL}")

    def judge(q):
        return q, core.decide_scope(q, {"raw_query": q}, q)

    questions = SHOULD_ANSWER + SHOULD_BLOCK + [q for pair in SAME_INTENT for q in pair]
    runs = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for _ in range(repeat):
            runs.append(dict(pool.map(judge, questions)))
    results = runs[0]
    if repeat > 1:
        flaky = [q for q in questions if len({r[q].status for r in runs}) > 1]
        print(f"重複 {repeat} 次，結果不一致的題目：{len(flaky)}/{len(questions)}")
        for q in flaky:
            print("   ", q, [r[q].status for r in runs])
    wrong_block = [q for q in SHOULD_ANSWER if results[q].status == "OUT_OF_SCOPE"]
    wrong_pass = [q for q in SHOULD_BLOCK if results[q].status != "OUT_OF_SCOPE"]
    for q in questions:
        d = results[q]
        mark = "✗" if q in wrong_block or q in wrong_pass else " "
        print(f"{mark} {d.status:<12} {str(d.office_hint):<6} {d.confidence:.2f} {q}　{d.reason[:40]}")
    mismatched = [(a, b) for a, b in SAME_INTENT
                  if (results[a].status, results[a].office_hint) != (results[b].status, results[b].office_hint)]
    print("\n中英文同義問法：")
    for a, b in SAME_INTENT:
        ra, rb = results[a], results[b]
        mark = "✗" if (a, b) in mismatched else " "
        print(f"{mark} {a}（{ra.status}/{ra.office_hint}） ↔ {b}（{rb.status}/{rb.office_hint}）")
    print(f"\n中英文判斷不一致：{len(mismatched)}/{len(SAME_INTENT)}")
    print(f"應回答卻被擋：{len(wrong_block)}/{len(SHOULD_ANSWER)}")
    print(f"應擋卻放行：{len(wrong_pass)}/{len(SHOULD_BLOCK)}")


if __name__ == "__main__":
    main()
