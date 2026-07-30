# NTPU AI Assistant

國立臺北大學行政服務 AI 助理，現階段支援以下三個單位：

- 體育室
- 通識教育中心
- 語言中心

系統會先判斷問題所屬單位，再使用 RAG（檢索增強生成）從爬蟲資料、法規與常見
問題中搜尋相關內容，最後由 OpenAI 模型整理回答並附上可用來源。

## 線上服務

| 用途 | 網址 |
|---|---|
| 正式網站 | <https://aia.ntpu.ai> |
| Cloud Run 前端 | <https://aia-web-187268224727.asia-east1.run.app> |
| API 健康檢查 | <https://aia-api-187268224727.asia-east1.run.app/api/health> |

若正式網站尚未完成 TLS 憑證核發，請暫時使用 Cloud Run 前端網址。

## 主要功能

- 體育室、通識教育中心、語言中心問題自動分類
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
Cloud Run：aia-web（Next.js）
  │
  ▼
Cloud Run：aia-api（FastAPI）
  ├─ 問題分類
  ├─ FAISS + BM25 檢索
  ├─ Agent 工具呼叫
  └─ OpenAI API
       ├─ GPT-5.4 Mini
       ├─ GPT-4o Mini
       ├─ Text Embedding 3 Small
       ├─ Whisper
       └─ TTS
```

目前部署於獨立的 GCP 專案 `aintpu-aia`，區域為 `asia-east1`。

## 專案結構

```text
.
├─ agentic_v2_5_4high.py        # FastAPI、RAG、Agent 與主要 Prompt
├─ llm_adapter.py               # OpenAI 模型介面
├─ crawler_data/                # 通識與語言中心爬蟲資料
├─ evaluate/                    # 評估工具與測試題
├─ front_end/sports-ai-chat/    # Next.js 前端
├─ Dockerfile                   # FastAPI Cloud Run 映像
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
| `GET` | `/api/health` | 健康狀態與模型資訊 |
| `POST` | `/api/chat` | 一般問答 |
| `POST` | `/api/chat/stream` | SSE 串流問答 |
| `POST` | `/api/voice` | 語音辨識、回答與 TTS |

文字問答範例：

```powershell
$body = @{
  question = "通識學分如何申請抵免？"
  history = @()
  session_id = "local-test"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://localhost:8000/api/chat `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

## 知識庫

Repository 目前包含：

- `crawler_data/cge_content.md`：通識教育中心資料
- `crawler_data/lc_content.md`：語言中心資料
- `crawler_data/北大學術單位法規彙整.xlsx`：法規 metadata
- `corrections.md`：人工修正內容

原始專案另外預期以下檔案，但它們被 `.gitignore` 排除，未包含在 repository：

- `all_content_v2.md`：體育室主要中文內容
- `all_content_en_v2.md`：體育室英文內容
- `ALL_files_2.md`：體育室法規與表單全文

缺少這些檔案不會阻止服務啟動，但體育室相關回答可能不完整。請向原資料維護者
取得，或使用原始爬蟲重新產生；不要以空白檔案代替。

## GCP 部署摘要

| 資源 | 名稱 |
|---|---|
| Project ID | `aintpu-aia` |
| Artifact Registry | `asia-east1-docker.pkg.dev/aintpu-aia/aia` |
| FastAPI Cloud Run | `aia-api` |
| Next.js Cloud Run | `aia-web` |
| Runtime service account | `aia-runtime@aintpu-aia.iam.gserviceaccount.com` |
| Secret Manager | `OPENAI_API_KEY` |
| Global IP | `8.232.127.58` |
| Custom domain | `aia.ntpu.ai` |

正式環境只把 `OPENAI_API_KEY` 放在 Secret Manager，Cloud Run revision 不應綁定
OpenRouter、明碼金鑰或服務帳戶 JSON 私鑰。

## 目前限制

- 尚未提供登入、使用者帳號與權限管理。
- 前端對話只存在目前分頁，重新整理後會消失。
- 後端會寫入 `chat_logs.csv`，但 Cloud Run 磁碟是暫存空間，不能視為永久紀錄。
- 沒有 Firestore 或其他永久對話資料庫。
- FAISS 索引在容器冷啟動時建立，首次回應可能較慢。
- 體育室主要知識庫檔案尚未納入 repository。
- Rate limit 儲存在單一 instance 記憶體，多 instance 時不會共享計數。

## 安全注意事項

- 不要把 API Key 貼到 GitHub、Markdown、前端程式或聊天訊息。
- 金鑰一旦出現在日誌或公開內容中，應立即撤銷並輪替。
- 正式金鑰只能存放於 GCP Secret Manager。
- `config.txt`、`.env.local`、對話紀錄與 FAISS cache 不應提交到 Git。
- 上線永久對話保存前，應先確認告知、同意、刪除與資料保留政策。

## Git remote

- `origin`：<https://github.com/aintpu/ntpu-ai-assistant>
- `upstream`：<https://github.com/borjen/ntpu-ai-assistant>

若要同步原始專案，請先檢視差異，不要直接覆蓋部署設定與本專案 Prompt。
