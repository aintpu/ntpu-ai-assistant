# NTPU AI Assistant

國立臺北大學行政服務 AI 助理，現階段支援以下七個單位：

- 體育室
- 通識教育中心
- 語言中心
- 教務處（僅法規辦法全文）
- 學務處（僅法規辦法全文）
- 人事室（差勤與勤休法規常見問答）
- 總務處（營繕、事務、經管、出納、環境與文書常見問答）

系統會先判斷問題屬於 `SYSTEM` 或哪個校務單位。SYSTEM 問題直接從核准的系統 FAQ
回答；校務問題再使用 RAG（檢索增強生成）從爬蟲資料、法規與常見問題中搜尋相關
內容，最後由設定的模型整理回答並附上來源。

## 線上服務

| 用途 | 網址 |
|---|---|
| 正式網站 | <https://aia.ntpu.ai> |
| 系統說明 | <https://aia.ntpu.ai/about> |
| API 健康檢查 | <https://aia.ntpu.ai/api/health>（淺層，不喚醒容器） |

## 主要功能

- 體育室、通識教育中心、語言中心、教務處、學務處、人事室、總務處問題自動分類
- SYSTEM FAQ：回答系統功能、使用方式、來源、限制、隱私與追問機制
- 法規、公告、常見問題與表單的語意檢索
- FAISS 向量檢索與 BM25 關鍵字檢索
- 串流文字回答
- 繁體中文與英文介面
- 圖片內容分析
- Whisper 語音辨識
- OpenAI TTS 語音輸出
- 每個 IP 每分鐘最多 15 次請求
- Prompt injection 基礎偵測

## 系統架構

```text
瀏覽器
  │
  ▼
Cloudflare Worker：ntpu-aia-api
  ├─ Static Assets（Next.js 靜態輸出）
  ├─ Durable Object（conversation state）
  └─ /api/* → Cloudflare Container（FastAPI + FAISS + BM25）
                  ├─ SYSTEM FAQ
                  ├─ 七處室 Router / Agent 工具呼叫
                  └─ 設定的 LLM、Embedding、Whisper / TTS API
```

前端與後端使用同一網域與 Worker。正式拓撲與操作方式見 [DEPLOY.md](DEPLOY.md)；
GCP Cloud Run 只保留為遷移附錄，不是現行正式架構。

## 專案結構

```text
.
├─ agentic_v2_5_4high.py        # FastAPI、RAG、Agent 與主要 Prompt
├─ system_faq.py                # SYSTEM intent、FAQ 檢索與 fallback
├─ system_content.json          # Backend 與 About Page 共用的 SYSTEM 內容
├─ llm_adapter.py               # OpenAI 模型介面
├─ docs/baseline/               # 由實際原始碼盤點的 Baseline SDD
├─ crawler_data/                # 各處室爬蟲、法規與常見問答資料
├─ evaluate/                    # 評估工具與測試題
├─ front_end/sports-ai-chat/    # Next.js 前端
├─ cf/                          # Cloudflare Worker、Container 與 Durable Object
├─ Dockerfile                   # FastAPI Container 映像
├─ requirements.txt             # Python 套件
└─ config.example.txt           # 環境變數範例
```

## 本機啟動

### 1. 啟動後端

需要 Python 3.11。

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item config.example.txt config.txt
```

編輯 `config.txt`，至少設定：

```text
OPENAI_API_KEY=你的金鑰
OPENAI_BASE_URL=https://api.openai.com/v1
MODEL_BIG=gpt-5.4-mini
MODEL_SMALL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_MAX_RETRIES=8
SYSTEM_PRIMARY_THRESHOLD=0.56
SYSTEM_FALLBACK_THRESHOLD=0.72
```

不要把 `config.txt` 或任何 API Key 提交到 Git。

啟動 API：

```powershell
uvicorn agentic_v2_5_4high:app --host 0.0.0.0 --port 8000
```

健康檢查：

```powershell
Invoke-RestMethod http://localhost:8000/api/health
```

### 2. 啟動前端

```powershell
Set-Location front_end\sports-ai-chat
npm ci
$env:NEXT_PUBLIC_API_URL="http://localhost:8000"
npm run dev
```

開啟 <http://localhost:3000>。

`NEXT_PUBLIC_API_URL` 會在 `next build` 時寫入瀏覽器端 JavaScript；變更 API 網址後
必須重新建置前端映像。

## API

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/api/health` | 淺層健康檢查；正式環境由 Worker 直接回應，不喚醒容器 |
| `GET` | `/api/health/backend` | 深層健康檢查；轉進容器，回傳健康狀態與模型資訊 |
| `POST` | `/api/chat` | 一般問答 |
| `POST` | `/api/chat/stream` | SSE 串流問答 |
| `POST` | `/api/voice` | 語音辨識、回答與 TTS |

文字問答範例：

```powershell
$body = @{
  question = "通識學分如何申請抵免？"
  history = @()
  session_id = "local-test"
  conversation_id = "local-test"
  conversation_state = @{}
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://localhost:8000/api/chat `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

## 知識庫

Repository 目前包含：

- `crawler_data/all_content_v2.md`：體育室網站主要內容
- `crawler_data/ALL_files_2.md`：體育室法規與表單全文
- `crawler_data/cge_content.md`：通識教育中心資料
- `crawler_data/ge_regulations_extra.md`：通識教育中心彙整表中原先缺漏的法規全文
- `crawler_data/lc_content.md`：語言中心資料
- `crawler_data/oaa_regulations.md`：教務處法規全文
- `crawler_data/osa_regulations.md`：學務處法規全文
- `crawler_data/hr_content.md`：人事室差勤與勞動基準法請假常見問答
- `crawler_data/hr_regulations.md`：人事室法規全文
- `crawler_data/oga_content.md`：總務處六組共 60 題常見問答
- `crawler_data/oga_regulations.md`：總務處法規全文
- `front_end/sports-ai-chat/public/documents/hr/`：人事室原始附件（1 份 DOCX、3 份 PDF），供回答來源直接開啟
- `crawler_data/北大學術單位法規彙整.xlsx`：ge/lc 法規 metadata（每處室一個分頁，英文欄名）
- `crawler_data/北大行政單位法規彙整.xlsx`：ope/oaa/osa/hr/oga 法規 metadata（單一 Sheet1、中文欄名，以「處室」欄篩選）
- `corrections.md`：人工修正內容
- `system_content.json`：About Page 與 SYSTEM FAQ 共用內容

教務處／學務處目前只接入法規辦法全文，沒有最新消息與常見問題；法規 URL 僅涵蓋
彙整表收錄的各 20 筆，其餘法規有全文但無來源連結。

可執行 `python knowledge_source_audit.py` 檢查七個支援處室的彙整表項目是否都有可檢索正文；
若只有標題／連結、正文缺漏或仍含解析失敗標記，檢查會以非零狀態結束。

`all_content_en_v2.md` 仍未接入目前的中文主索引。資料更新必須依序完成 source file
更新、FAISS/BM25 重建與正式部署；只改網站文案不會更新知識庫。

## Cloudflare 部署摘要

| 資源 | 名稱 |
|---|---|
| Worker | `ntpu-aia-api` |
| Frontend | Workers Static Assets |
| Backend | Cloudflare Container（`standard-1`） |
| Conversation State | SQLite-backed Durable Object storage |
| Runtime Secret | Cloudflare Worker Secret `OPENAI_API_KEY` |
| Custom domain | `aia.ntpu.ai` |

push `main` 後由 GitHub Actions 預建 FAISS、建置 Next.js static export，再執行
`wrangler deploy`。CI 預建索引使用獨立的 GitHub Actions secret。

## 目前限制

- 尚未提供登入、使用者帳號與權限管理。
- 前端在同一分頁的 `sessionStorage` 保存 `conversation_id`、精簡 state 與最近 20 則可見訊息；Cloudflare 正式環境再以 Durable Object storage 依 key 保存 Conversation State（主題、處室、上一輪 query、來源 ID）。重新整理後會同步還原畫面與上下文；若偵測到只有舊 state、沒有可見訊息的舊版 session，會改開新對話，避免套用使用者看不到的背景上下文。
- 結構化事件寫到 stdout；本機另可寫 `events.jsonl`，Container 檔案不可視為永久儲存。
- Cloudflare 正式環境不依賴 Firestore；session state 存在 Durable Object storage。
- CI 若無法預建 `.faiss_cache`，Container 冷啟動時才會完整建索引，首次回應較慢。
- Rate limit 位於 FastAPI instance 記憶體；多 instance 時不共享計數。
- SYSTEM FAQ 是文字檢索與核准答案，不代表新增了其他校務處室資料。

## 安全注意事項

- 不要把 API Key 貼到 GitHub、Markdown、前端程式或聊天訊息。
- 金鑰一旦出現在日誌或公開內容中，應立即撤銷並輪替。
- 正式 runtime 金鑰只能存放於 Cloudflare Worker Secret；CI 金鑰存 GitHub Actions Secret。
- `config.txt`、`.env.local`、對話紀錄與 FAISS cache 不應提交到 Git。
- 目前 Durable Object 只保存精簡的 Conversation State，閒置超過 30 天的 state 會在下次讀取時清除；若日後擴大為完整對話紀錄，應先確認告知、同意、刪除與資料保留政策。

## Git remote

- `origin`：<https://github.com/aintpu/ntpu-ai-assistant>
- `upstream`：<https://github.com/borjen/ntpu-ai-assistant>

若要同步原始專案，請先檢視差異，不要直接覆蓋部署設定與本專案 Prompt。
