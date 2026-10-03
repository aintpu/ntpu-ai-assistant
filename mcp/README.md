# NTPU AIA — 資料匯入與 MCP（各處室官網公告）

依照戴敏育老師提供的 AI4X MCP Core 12 規格（Spec-Driven Development），把 NTPU AIA 的知識來源
從「人工 commit 的 Markdown」逐步改成「排程自動抓官網 → 有版本紀錄的資料庫 → MCP 查詢工具」。

這個資料夾從規格建議的**第一條 vertical slice**（研發處公告）開始，驗證通過後擴充到
全部 21 個單位（清單在 `src/ingestion/source-registry.ts`）：

```text
15 個官方來源（各處室公告 API）
  → 安全抓取（只允許登記過的網址）
  → 原始回應存 R2
  → 解析 / 正規化 / schema 驗證
  → SHA-256 / 比對 / 版本紀錄
  → D1 正式資料
  → 2 個唯讀 MCP 工具（search_announcements、get_announcement）
  → 測試
```

**不影響正式站**：`aia.ntpu.ai`（`cf/` + FastAPI 容器）完全沒改。`deploy.yml` 只在特定路徑變動時部署，
`mcp/` 不在其中；這裡的 Worker 另外部署，名稱不同、資料庫不同。

## 架構

```text
new.ntpu.edu.tw 的資料來源
api-carrier.ntpu.edu.tw/strapi (GraphQL)
        │  HTTPS，只允許 source-registry 登記的 entrypoint
        ▼
ntpu-aia-ingest（Cron Worker，每 10 分鐘觸發，每次只跑一個到期的處室；每個處室每天一次）
        ├─ 原始回應 → R2  raw/{source}/{yyyy}/{mm}/{dd}/{sha256}.bin + .meta.json
        ├─ 解析 → 正規化 → Zod 驗證
        ├─ SHA-256 比對：相同→只更新驗證時間；不同→舊版存 record_versions、目前版本 +1
        └─ D1：sources / entities / record_versions / ingestion_runs / ingestion_items
                │
                ▼
ntpu-aia-mcp（HTTP Worker，只讀 D1）
        ├─ POST /mcp   MCP Streamable HTTP（stateless，JSON 回應）
        ├─ GET  /health 各來源最後成功時間與是否過期
        └─ GET  /about  服務說明
```

兩個 Worker 分開部署（規格 06 §4）：抓取 Worker 沒有任何公開觸發點，MCP Worker 不能連外、沒有 R2 權限。

## 目錄

| 路徑 | 內容 | 規格章節 |
|---|---|---|
| `migrations/` | D1 資料表（0001 建表、0002 隔離區與執行狀態、0003 每處室一筆、0004 待抓內文數） | 06 §16–20 |
| `src/ingestion/source-registry.ts` | 允許抓取的來源清單 | 06 §6 |
| `src/ingestion/url-policy.ts` | 網址 allowlist、SSRF 阻擋 | 06 §7–8.1 |
| `src/ingestion/fetch-source.ts` | 逾時、大小上限、content-type、轉址檢查 | 06 §8 |
| `src/ingestion/raw-archive.ts` | R2 原始檔（不可覆寫） | 06 §9 |
| `src/ingestion/adapters/` | 各類來源：strapi 公告、strapi 介紹頁、HTML 公告網站 | 06 §10 |
| `src/ingestion/normalizers/` | 公告正規化（只用原文，不推論） | 06 §11 |
| `src/shared/schemas.ts` | Zod schema、Provenance | 06 §12、07 §5 |
| `src/db/canonical-store.ts` | 比對、版本、交易式寫入 | 06 §13–15、§21 |
| `src/ingestion/run-ingestion.ts` | 排程流程、消失政策、drift 偵測 | 06 §22、§36–37 |
| `src/mcp/` | MCP 工具、domain service、HTTP | 04、08 |
| `tests/` | unit / integration / security | 06 §31–32、10 |

## 開發

```bash
cd mcp
npm ci
npm run typecheck
npm test                  # 全部測試（用 node:sqlite 模擬 D1，跑真正的 migration 與 SQL）
npm run db:migrate:dev    # 建立本機 D1
npm run dev:mcp           # 本機 MCP：http://localhost:8787/mcp
npm run dev:ingest        # 本機抓取 Worker，之後打 /__scheduled 觸發一次
```

## 第一次設定 staging（需要 Cloudflare 帳號權限，只做一次）

```bash
cd mcp
npx wrangler d1 create ntpu-aia-canonical-staging
npx wrangler r2 bucket create ntpu-aia-raw-staging
```

把 `d1 create` 印出的 `database_id` 填進 `wrangler.ingest.jsonc` 與 `wrangler.mcp.jsonc` 的
`env.staging`（取代 `REPLACE_WITH_STAGING_D1_ID`），commit 後到 GitHub Actions 手動執行
**Deploy MCP to staging**。repo 現有的 `CLOUDFLARE_API_TOKEN` 需要有 Workers、D1、R2 的編輯權限。

部署後：

1. 在 Cloudflare 後台對 `ntpu-aia-ingest-staging` 手動觸發一次 Cron（或等到台灣時間 02:00）。
2. 打 `https://ntpu-aia-mcp-staging.<子網域>.workers.dev/health`：`lastSuccessAt` 有值就代表
   Cloudflare 連得到學校 API。若 `ingestion_runs` 顯示 `FETCH_HTTP_ERROR` 或 `DEPENDENCY_UNAVAILABLE`，
   代表學校擋了 Cloudflare 的連線，抓取改在校內或本機執行，再寫入同一個 D1／R2。
3. 用 MCP client（例如 Claude）連 `/mcp`，測 `search_announcements`。

## 收錄範圍（21 個單位）

| 類型 | 單位 | 來源 | MCP 工具 |
|---|---|---|---|
| 公告（15） | ord 研發處、oga 總務處、osa 學務處、oaa 教務處、oa 主計室、cic 資訊中心、oia 國際處、eec 進修推廣部、alumni 校友中心、edusp 高教深耕、os 秘書室、sustainable 永續辦公室、ope 體育室、cge 通識中心、op 人事室 | 學校 Strapi API（`strapi-publications`） | `search_announcements`、`get_announcement` |
| 公告（2） | library 圖書館、lc 語言中心 | 各自網站的 HTML（`html-news`） | 同上 |
| 介紹頁（4） | president 校長室、vice-president-academic／-administration／-financial 三位副校長室 | 學校 Strapi sections（`strapi-sections`） | `search_pages`、`get_page` |

- **同一則公告刊在多個處室**（2026-10-03 實查 203 則）：每個處室各存一筆，`stable_key` 是
  `處室:編號`，各自追蹤版本、來源網址與下架。`search_announcements` 合併成一筆並以 `postedBy`
  列出刊登處室；`get_announcement` 可加 `unit` 指定處室。`0003` migration 把既有研發處資料改成新 key，不改內容與版本。
- **永續辦公室**的公告連結是 `esdg.ntpu.edu.tw/news/<id>`（new.ntpu.edu.tw/sustainable/news 會顯示找不到）。
- **介紹頁**只抓設定裡的頁面路徑（不含標 deprecated 的舊頁），不查 `editors` 欄位（含承辦人信箱）。
- **圖書館、語言中心（HTML 網站）**：
  - 每次翻完整個列表（判斷哪些公告還在），再依「新公告 → 列表上標題或日期有變 → 超過 7 天沒驗證」
    的順序抓最多 60 則內文；其餘記在 `sources.pending_count`，排程 15 分鐘後優先接著抓。
    語言中心約 434 則，第一次要分 8 次左右才抓完，這段期間 `/health` 會顯示 degraded。
  - 每個請求間隔 1 秒；只允許登記的列表／內文路徑，內文編號必須符合固定格式（`queryRules`）。
  - 日期是官網上的台灣日期，存成當天 00:00（UTC+8）。
  - **個人資料**（`src/ingestion/personal-data.ts`，全部 17 個公告來源都開啟）：名單類公告不收錄，記在 `quarantined_records`
    （原因 `PERSONAL_DATA`），保留原始檔可追溯；不算驗證失敗，也不會每天重抓。判斷規則：
    遮罩姓名（O、○、〇、＊、x 等，排除「二〇二六」這類中文數字）、完整或部分遮罩的學號、
    標題像名單／結果公告且內文有 10 個以上像姓名的項目。已收錄的公告若重新驗證時被擋下，
    狀態改為 `withheld`，MCP 不再提供（不刪除）。
  - 規則更新後要重新檢查已收錄的公告：本機打
    `/__scheduled?cron=reverify:lc-announcements:<規則更新的 UTC 時間，例如 2026-10-03T10:25:00Z>`，
    每次 60 則，用同一個時間重複執行到 deferred 為 0。
- **一次只跑一個來源**：Cloudflare 對每次執行有 D1 查詢數與子請求數上限。每頁只用 1–2 次讀取
  加 1 個 batch 寫入；最大的高教深耕（約 20 頁）一次約 90 個 D1 查詢、80 個子請求，語言中心
  一次約 130 個請求、500 個子請求，**超過 Workers 免費方案的上限，staging/production 需要 Workers Paid**。
- 本機指定來源：`/__scheduled?cron=source:lc-announcements`；不指定就挑下一個到期的來源。

## 與規格的差異（刻意的決定）

- **POST 抓取**：strapi 的 GraphQL 只接受 POST。請求內容由 parser 用固定查詢產生，只帶站台代碼、
  分頁位置、目前時間三個參數，外部無法指定。
- **Workers 沒有 DNS 解析結果**：SSRF 防護改用「主機名稱必須完全等於登記的來源」加上拒絕所有 IP、
  localhost、metadata 主機名稱。
- **entities 多了 `title`、`search_text`、`status`、`missing_runs`**：前兩個是從 payload 衍生、只供查詢；
  後兩個實作消失政策（連續 3 次完整抓取都沒看到才標為 inactive，從不刪除）。
- **關鍵字搜尋用 SQL LIKE**：規格建議先用 SQL／欄位查詢，向量索引之後才加且只能是衍生資料。

## 尚未完成（下一步）

- [ ] 建立 staging 的 D1／R2 並部署，確認 Cloudflare 能否連到 `api-carrier.ntpu.edu.tw`
- [ ] 用真實回應存一份 fixture 到 `tests/`（目前 fixture 依照既有爬蟲的欄位格式手寫）
- [ ] 讓 AIA 聊天機器人的研發處問題改從 D1 取資料，與現有版本比對答案品質
- [ ] 加入檔案清單、內容頁（cms-carrier）兩種來源
- [ ] 登記非網站來源（各處室 FAQ Excel、人事室整理檔、`corrections.md`）為 `manual_verified`
- [x] 其他處室加入 source registry（15 個有公告的處室）
- [x] 校長室、副校長室的介紹頁，圖書館、語言中心的網站
- [ ] Golden set 評估、contract snapshot 測試（規格 10）
- [ ] 正式環境網域與上線驗收（規格 11）
