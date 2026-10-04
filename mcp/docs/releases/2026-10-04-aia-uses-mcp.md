# 2026-10-04 MCP 長關鍵字修正；AIA 法規、常見問答改查 MCP

| 項目 | 值 |
|---|---|
| Git commit | `cba08d6`（PR #14，MCP）；`380ebf8`（PR #16，AIA）；`5790140`（PR #17，文件） |
| ntpu-aia-mcp 版本 | `7e6cf273-…` → `c10a06e9-f1b7-4327-85a8-a5ccb363475d` |
| ntpu-aia-ingest 版本 | 未重新部署 |
| ntpu-aia-api（AIA）版本 | `98c02664-5b07-4145-951c-c39ddd5d9299`（設定 secret `MCP_REGULATIONS=1` 後重新部署） |
| D1 migration | 無 |
| 部署者 / 時間（台北） | 盧信廷 / 2026-10-04 |

## 變更

- MCP：關鍵字比對由 `LIKE` 改為 `instr(lower())`。17 個中文字以上的關鍵字以前會超過 D1 的 LIKE 樣式上限（約 50 bytes）而回 `INTERNAL_ERROR`。
- AIA：法規、常見問答改查 MCP（`MCP_REGULATIONS=1`，以 Worker secret 設定）；體育室、通識、語言中心、校長室維持本機。
- AIA：範圍判斷改以資料為依據（知識庫標題含問題內容詞即不擋）；補外校簡稱並檢查前一個字。

## 驗證

- 正式模型端到端評估（`evaluate/mcp_records_model_eval.py`，36 題）：MCP 25/36、本機 19/36；回應時間中位數 9.1 秒 vs 32.0 秒。
- 範圍誤擋檢查（`evaluate/scope_probe.py`，75 題）：應回答卻被擋 0/63，應擋卻放行 0/12。
- 正式站：事假、校友證、交換學費、學生請假辦法都有回 `data_updated_at`（確實走 MCP）；信義會館、北聯大、行天宮、全民國防教育法、內部稽核不再被擋；政大、台大仍擋。
- MCP：17 字關鍵字可正常查詢；`/health` 28/28 fresh。

## 冪等（規格 06 §22）

正式環境 19 個公告／介紹頁來源已完成第二輪抓取：全部 `published 0`，資料皆為 unchanged，沒有新增版本。
全部 136 筆歷史版本都來自 `oaa-regulations` 在 10/04 05:31→05:40 之間的變更（中間部署 PR #5，`sourceUrl` 改為 null），屬於真實內容變更。

## 還原方式

- AIA 法規／FAQ 改回本機：`printf '0' | npx wrangler secret put MCP_REGULATIONS --name ntpu-aia-api`，再 `gh workflow run deploy.yml --ref main`。
- MCP：`npx wrangler rollback --name ntpu-aia-mcp` 回到 `7e6cf273-…`。

## 已知問題

- 「用學校 VPN 有什麼要注意」：範圍判斷正確，但檢索沒找到該筆 FAQ（新舊路線都一樣）。
- 範圍判斷的模型偶爾對同一題給出不同結果。
- 人工整理檔來源的第二輪抓取在 2026-10-05 約 01:30Z，尚待確認。
