# 部署手冊

正式環境為 **Cloudflare Workers + Containers**，前後端共用同一個 Worker。
GCP Cloud Run 為過渡期的舊環境，`aia.ntpu.ai` 切換完成後即可停用（見附錄 A）。

---

## 1. 架構

```
使用者 ──► Worker「ntpu-aia-api」
             ├─ /            → Static Assets（Next.js 靜態輸出）
             ├─ /about       → Static Assets（系統說明頁）
             └─ /api/*       → Durable Object（session JSON storage）→ Container（FastAPI + FAISS）
```

前後端**同源**，因此：

- 不需要 CORS 設定
- 前端呼叫 API 用相對路徑（`/api/chat`），換網域不必重新建置

### 對話狀態保存

每個 `conversation_id` 對應 Durable Object storage 的一筆 JSON：

```text
conversation-session:<conversation_id> → {
  version,
  conversation_id,
  state: { active_topic, active_office, previous_standalone_query, previous_source_ids, ... },
  updated_at
}
```

Worker 轉發 `/api/chat`、`/api/chat/stream`、`/api/voice` 前，會先用
`conversation_id` 讀取這份 state；回答完成後再把後端回傳的最新 state 寫回去。
只保存 resolver 所需的精簡欄位，不保存完整 `history`。目前 state 閒置 30 天後，
下次讀取時會被視為過期並清除。

| 項目 | 值 |
|---|---|
| Cloudflare 帳號 | `Aintpu@gmail.com` |
| Account ID | `cedba9318e222f84b8eb05c184c99443` |
| Worker | `ntpu-aia-api` |
| 測試網址 | `https://ntpu-aia-api.aintpu.workers.dev` |
| 容器規格 | `standard-1`（0.5 vCPU / 4 GiB / 8 GB） |
| 正式網域 | `aia.ntpu.ai`（zone 已在同一帳號） |

---

## 2. 日常更新：只要 `git push`

推上 `main` 就自動部署，**開發機不需要安裝 Docker**（CI runner 自帶）。

```bash
git push origin main
```

進度：https://github.com/aintpu/ntpu-ai-assistant/actions

流程（`.github/workflows/deploy.yml`）：

1. 預先建立 FAISS 索引 → 讓映像檔帶著 `.faiss_cache`
2. 建置前端（`next build`，靜態輸出到 `out/`）
3. `wrangler deploy` → 建置映像檔、推送、部署 Worker 與 Container

首次約 10 分鐘，之後有快取約 3–5 分鐘。

> **為什麼要在 CI 預先建索引**：容器冷啟動時若需重建索引，5178 筆實測要 **96 秒**，
> 休眠後第一位使用者就得等這麼久。預先建好可縮短到約 4 秒。
> 代價是每次部署多一次 embedding 費用（約 US$0.10）。

---

## 3. 金鑰設定（只需做一次）

金鑰分屬三個地方，用途不同，**不要混用**：

| 位置 | 用途 | 設定方式 |
|---|---|---|
| Cloudflare Worker Secret | 容器執行時呼叫 OpenAI | 後台 → Settings → Variables and secrets，型別選 **Secret** |
| GitHub `OPENAI_API_KEY` | CI 預先建索引 | repo → Settings → Secrets → Actions |
| GitHub `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID` | CI 部署權限 | 同上 |

SYSTEM FAQ 的路由門檻預設由 Worker 傳入 Container：

- `SYSTEM_PRIMARY_THRESHOLD=0.56`
- `SYSTEM_FALLBACK_THRESHOLD=0.72`（必須高於 primary）

若要調整，可在 Worker Variables and secrets 設定一般 Variable 後重新部署；未設定時使用上述預設值。

> ⚠️ **新增或更換 Worker Secret 後必須重新部署**。Durable Object 是長期存活的，
> 其建構式取得的 `env` 會沿用到執行個體被汰換為止；只在後台改 secret 而不重新
> 部署，容器仍會拿到舊值（表現為所有問答都失敗、回應只需 5–7 秒）。
> 重新部署可直接推一個 commit，或在 Actions 頁面手動 **Run workflow**。

診斷：容器啟動時會輸出下列事件，可在 Observability 確認金鑰是否送達（只記錄長度，不記錄內容）：

```json
{"event":"container_env_check","openai_api_key":"present(len=164)"}
```

---

## 4. 綁定正式網域 `aia.ntpu.ai`

> **先在 `workers.dev` 測試通過再做這步。** `aia.ntpu.ai` 目前指向 GCP 且正在服務學生，
> 切換過程中若 Worker 有問題會直接影響使用者。

### 4.1 先移除指向 GCP 的舊 DNS 記錄

自訂網域與既有 DNS 記錄會衝突，必須先刪掉舊的。

1. Cloudflare 後台 → **Domains** → `ntpu.ai` → **DNS → Records**
2. 搜尋 `aia`，找到指向 `8.232.127.58` 的 **A 記錄**（雲朵應為灰色 DNS only）
3. **先把內容記下來**（回滾時要用），再刪除

```
類型  名稱  內容            Proxy
A     aia   8.232.127.58    DNS only（灰雲）
```

### 4.2 加入自訂網域

1. **Workers & Pages** → `ntpu-aia-api` → **Domains**（或 Settings → Domains & Routes）
2. **Add** → **Custom domain**
3. 輸入 `aia.ntpu.ai` → 確認

Cloudflare 會自動建立所需的 DNS 記錄並簽發憑證，通常 1–2 分鐘生效。

### 4.3 驗證

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://aia.ntpu.ai/api/health/backend
```

```bash
curl -s -I https://aia.ntpu.ai/ | grep -i "^server"
```

回應標頭應為 `server: cloudflare`。若仍是 `Google Frontend`，表示 DNS 尚未生效或舊記錄還在。

接著跑第 5 節的抽測。

### 4.4 回滾

把 4.2 建立的自訂網域移除，再依 4.1 記下的內容重新建立 A 記錄指回 `8.232.127.58`，
即可回到 GCP（前提是 Cloud Run 服務尚未刪除）。

---

## 5. 部署後驗證

### 5.1 靜態資源與 API

```bash
curl -s -o /dev/null -w "首頁 %{http_code}\n" https://aia.ntpu.ai/
```

```bash
curl -s -o /dev/null -w "說明頁 %{http_code}\n" https://aia.ntpu.ai/about
```

```bash
# 淺層：Worker 邊緣回應，不喚醒容器（監控請用這個）
curl -s https://aia.ntpu.ai/api/health

# 深層：會進容器，用來確認後端與模型設定
curl -s https://aia.ntpu.ai/api/health/backend
```

### 5.2 各處室抽測

用瀏覽器實際問，逐題確認：

| 處室 | 測試問題 | 失敗代表 |
|---|---|---|
| 體育室 | 體育室有哪些表單可以下載 | `ALL_files_2.md` 未進映像檔 |
| 體育室 | 112 學年度全大運我們拿了什麼名次？ | `all_content_v2.md` 未進映像檔 |
| 教務處 | 辦理休學需要哪些程序？ | OAA 資料未載入 |
| 學務處 | 弱勢學生助學金如何申請？ | OSA 資料未載入 |
| 人事室 | 身心調適假可以請幾天？ | HR 常見問答未載入或分類失敗 |
| 人事室 | 忘記刷卡該如何補辦？ | HR 常見問答未載入或分類失敗 |
| 人事室 | 差勤系統故障時如何辦理簽到退與差假？ | HR 暫行措施未載入或分類失敗 |
| 總務處 | 學雜費繳費單要去哪裡查詢與繳納？ | OGA FAQ 未載入或分類失敗 |
| 通識 | 向度通識畢業門檻 | GE 迴歸問題 |
| 語言中心 | 大學英文抵免及免修方式 | LC 迴歸問題 |
| SYSTEM | 你可以回答哪些問題？ | 應直接回七處室服務範圍與「系統說明」來源，不應強迫分到處室 |
| SYSTEM fallback | 資料從哪來 | 原 Router 判 OTHER 時，應以較高門檻命中系統資料來源 FAQ |
| OTHER | 明天台北會下雨嗎？ | 不應誤命中 SYSTEM FAQ，應明確說目前不支援 |

> 回應時間約 **4–10 秒**。若只花 5–7 秒卻回「目前這個問題我暫時無法整理出明確答案」，
> 通常是 OpenAI 呼叫失敗（金鑰未送達容器），見第 3 節的警告。

### 5.3 分類器是否正常

```bash
curl -s -X POST https://aia.ntpu.ai/api/chat -H "Content-Type: application/json" -d '{"question":"推薦附近的餐廳","history":[]}'
```

應回 `"status":"blocked"`。若回 `"status":"ok"`，代表 `classify_department` 的 LLM 呼叫失敗而 fallback。

### 5.4 追問連貫性與 reload

1. 先問「外語能力畢業門檻」並記下回應。
2. 接著問「要幾分」，確認回答仍使用語言中心的上一個主題。
3. 重新整理頁面後再問「那需要什麼證明」，確認同一分頁的 `conversation_id`
   仍能從 Durable Object storage 讀回上一輪 state。
4. 點「新對話」後再問同一句，確認已使用新的 `conversation_id`，不會沿用舊主題。

### 5.5 回饋機制

在瀏覽器問一題，點回答下方的 👍／👎，確認出現「感謝你的回饋！」。

---

## 6. 查看使用狀況與回饋

系統將兩種結構化事件以單行 JSON 輸出到 stdout，可在
**Workers & Pages → `ntpu-aia-api` → Observability → Logs** 查看。

| 事件 | 內容 |
|---|---|
| `guardrail` | conversation_id、raw_query、追問／換題判定、standalone_query、resolver／scope 信心、scope 狀態、選定處室 |
| `answer` | message_id、session_id、conversation_id、raw／standalone query、追問／換題判定、處室、來源、FAISS／BM25／previous source／rerank IDs、evidence、工具、模型、耗時 |
| `feedback` | message_id、session_id、rating、原因分類、文字說明 |

兩者以 `message_id` 對應。

分析（滿意率、負評原因分布、各處室滿意率、負評案例）：

```bash
python analyze_feedback.py
```

本機開發時事件會另外寫入 `events.jsonl`；容器環境則跳過寫檔（檔案系統是暫時的），
改由上述日誌保存。要分析正式環境的資料，先從 Observability 匯出成 JSONL，再：

```bash
python analyze_feedback.py cloud_events.jsonl
```

---

## 7. 成本

Workers Paid US$5/月，含 25 GiB-hours 記憶體、375 vCPU-minutes、200 GB-hours 磁碟。
容器休眠期間不計費（`sleepAfter` 設為 30 分鐘）。

以 `standard-1` 估算：

| 情境 | 每月清醒時數 | 估計月費 |
|---|---|---|
| 零星使用 | ~100 小時 | 約 US$12 |
| 常態使用 | ~240 小時 | 約 US$23 |
| 完全不休眠 | 730 小時 | 約 US$58 |

建議在後台設定 **Budget Alert**。

---

## 8. 已知限制

- **OAA/OSA 法規來源連結覆蓋率低**：教務處 20/156、學務處 20/170。
  其餘法規有全文但無連結，前端「參考來源」只顯示標題。需補資料而非改程式。
- **OAA/OSA 沒有最新消息與常見問答**：只接了法規全文。問「註冊截止日」「承辦人電話」
  這類會查無，系統會誠實說明並建議洽詢該處室。
- **`osa_regulations.md` 有 6 筆是「未能抽出全文」的佔位**，只有連結沒有內文。
- **`corrections.md` 寫在容器檔案系統內**：執行個體回收後使用者的修正即消失，
  且不會同步回 repo。要長期保存需改存 R2 或資料庫。
- **冷啟動**：容器休眠後首次請求需等待喚醒（容器 1–3 秒 + 後端載入索引約 4 秒）。

---

## 附錄 A：GCP（過渡期舊環境）

`aia.ntpu.ai` 切換到 Cloudflare **之前**，服務仍由 GCP Cloud Run 提供。

| 項目 | 值 |
|---|---|
| Project ID | `aintpu-aia` |
| 區域 | `asia-east1` |
| 後端 | Cloud Run `aia-api` |
| 前端 | Cloud Run `aia-web` |
| 金鑰 | Secret Manager `OPENAI_API_KEY` |

### 切換完成後的收尾

1. 觀察 Cloudflare 版本穩定數日
2. 停用或刪除 Cloud Run 的 `aia-api` 與 `aia-web`
3. **確認 GCP 已不再服務後**，再作廢舊的 OpenAI 金鑰
   （GCP 使用的是舊金鑰；提早作廢會使 `aia.ntpu.ai` 立即中斷）

> 這台開發機未安裝 gcloud CLI。若需操作 GCP，須先安裝 Google Cloud SDK
> 或改用 Cloud Shell。
