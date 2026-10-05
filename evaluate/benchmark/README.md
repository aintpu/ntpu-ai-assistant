# NTPU AIA Benchmark 題庫

依戴敏育老師「NTPU AIA 成效評估具體執行方案」第二節建立的題庫。用於每月的有據正確率、高風險重大錯誤率抽查。

**題庫只用於評估，不放進系統**：放進系統等於先把答案給它，評估會失真；模型產生的題目也尚未經人工審核。
`evaluate/` 已被 `.dockerignore` 排除，機器人的知識庫索引與 MCP 上傳都只讀 `crawler_data/`。

## 產生方式

```bash
# 1. （需要 OpenAI 金鑰）由模型補題，寫入 generated.jsonl；可中斷後續跑
#    regs.json 為 MCP 法規匯出：wrangler d1 execute ntpu-aia-canonical --remote --json --command
#    "SELECT source_unit, stable_key, title, payload_json, source_url FROM entities WHERE entity_type='regulation' AND status='active' AND source_unit IN ('oaa','osa','op','oga')"
python evaluate/benchmark/generate.py --regs regs.json
# 2. 合併種子題庫與 generated.jsonl，產生 benchmark.jsonl 與 coverage.md（不呼叫模型）
python evaluate/benchmark/build_seed.py
```

目前共 **2,521 題**，21 個單位都達到題數目標，題型比例接近老師的建議。詳見 [coverage.md](coverage.md)。

| 來源 | 題數 | 標準答案 | 官方來源／資料日期 |
|---|---|---|---|
| 14 個單位的 FAQ（`crawler_data/*_faq.md`） | 938 | FAQ 原文回答 | 有 |
| 人事室、總務處整理檔（`hr_content.md`、`oga_content.md`） | 100 | 原文回答 | 有來源網址；人事室沒有資料日期 |
| 體育室、通識、語言中心歷次測試題（`evaluate/test_questions_v3/v4.json`） | 302 | 測試題的 ground truth | **沒有** |
| 應拒答題（`scope_probe.py` 應擋題、golden set 查無題） | 14 | 「應拒答」或「應回答查無」 | 不適用 |
| **模型產生**：法規題（教務 100、學務 100、人事 60、總務 40） | 300 | 由條文出題，須標註條次 | 法規名稱、官方檔案連結、更新日期 |
| **模型產生**：口語化／改寫題 | 504 | 沿用原題 | 沿用原題；`paraphrase_of` 記錄原問題 |
| **模型產生**：追問題 | 125 | 從原答案擷取 | 沿用原題；`history` 為第一輪問答 |
| **模型產生**：應拒答題（外校、無關、個資、不當協助、本校但查無） | 238 | 依類型（`refuse_kind`） | 不適用 |

## 每題欄位

老師要求每題包含：標準答案、官方來源、資料日期、風險等級、是否可回答。

| 欄位 | 說明 |
|---|---|
| `id` | 題號（FAQ 沿用 FAQ 編號） |
| `dept` / `dept_name` | 單位代碼／名稱；外校或無關問題為空 |
| `type` | 題型：`faq` 常見問題、`paraphrase` 口語化／改寫、`procedure` 程序資格期限、`followup` 追問、`unanswerable` 無答案／應拒答 |
| `question` | 題目 |
| `standard_answer` | **標準答案** |
| `official_source` | **官方來源**：`{name, url}` |
| `source_date` | **資料日期** |
| `risk_level` | **風險等級**：`high`（答錯影響權益：學分、資格、期限、金錢、獎懲、學籍、差勤）／`medium`／`low`（聯絡方式、地點、簡介） |
| `answerable` | **是否可回答**；`false` 代表應拒答或應回答查無 |
| `origin` | 題目從哪個檔案轉來 |
| `reviewed` | 是否經人工審核；種子題庫全部為 `false` |

## 分類規則（自動，需人工抽查）

- **題型**：問題含「怎麼申請、流程、資格、條件、期限、截止、何時…」歸為 `procedure`，其餘為 `faq`。
- **風險等級**：只看問題本身。含學分、抵免、畢業、資格、期限、罰、退學、休學、學費、補助、獎學金、薪資、請假、保險、兵役、成績、學籍等為 `high`；問電話、地址、位置、聯絡、開放時間、是誰等為 `low`；其餘為 `medium`。
- **核心處室**（目標 ≥100 題）：教務處、學務處、人事室、總務處、圖書館。可在 `build_seed.py` 的 `CORE_DEPTS` 調整。

## 產生時的品質處理

- 法規題：第一版題目常省略法規適用的身分（例如服役彈性修業被問成一般學生），且多以「如果我…」開頭；改寫出題規則後全部重產。
- 應拒答題：第一版「外校」類 48 題全部誤出成「國立臺北大學的校外活動」（其實應該回答），已全數排除並改寫說明重產。
- 合併時自動排除：提到本校的外校／無關類應拒答題、答案沒有中文內容的追問題（見 coverage.md）。

## 下一步

1. 人工抽查模型產生的題目與風險等級，審核後把 `reviewed` 設為 `true`（建議先抽查高風險題）。
2. 建立每月評估腳本：抽 100 題一般題、50 題高風險題，計算有據正確率與重大錯誤率。
3. 「程序、資格、期限」目前 12%（目標 15%），可再由法規多出程序類題目。
