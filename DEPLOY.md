# 部署到 GCP — 操作手冊

本次變更：整合教務處（OAA）與學務處（OSA），索引由 3404 筆增為 5178 筆。

---

## 0. 先決條件

### 0.1 安裝 gcloud CLI（這台電腦目前沒有）

從 https://cloud.google.com/sdk/docs/install#windows 下載安裝，然後：

```bash
gcloud auth login
```

```bash
gcloud config set project aintpu-aia
```

```bash
gcloud auth configure-docker asia-east1-docker.pkg.dev
```

### 0.2 環境資訊（取自 README）

| 項目 | 值 |
|---|---|
| Project ID | `aintpu-aia` |
| 區域 | `asia-east1` |
| Artifact Registry | `asia-east1-docker.pkg.dev/aintpu-aia/aia` |
| 後端 Cloud Run | `aia-api` |
| 前端 Cloud Run | `aia-web` |
| Runtime 服務帳戶 | `aia-runtime@aintpu-aia.iam.gserviceaccount.com` |
| Secret Manager | `OPENAI_API_KEY` |
| 正式網域 | `aia.ntpu.ai` |

---

## 1. 推上 GitHub

這個資料夾目前**還不是 git repo**，要先初始化。

```bash
cd "C:\Users\chenb\Desktop\ntpu_ai-assistant_202608\ntpu-ai-assistant-main"
```

```bash
git init -b main
```

### 1.1 ⚠️ 送出前務必確認金鑰沒有被納入

```bash
git add -A && git status --short | grep -iE "config\.txt|\.env" || echo "OK：config.txt 與 .env.local 都沒有被 add"
```

上面那行**必須**印出 `OK：...`。若印出檔名就是 `.gitignore` 失效，**先停下來**，不要 commit。

### 1.2 確認五個處室的資料檔都有進去

```bash
git status --short crawler_data/ | sort
```

**六個資料檔一個都不能少**，否則對應處室上線後會查無資料：

| 檔案 | 對應 |
|---|---|
| `all_content_v2.md` | 體育室 最新消息／常見問題／96 筆競賽成績 |
| `ALL_files_2.md` | 體育室 808 筆法規與表單 |
| `cge_content.md` | 通識教育中心 |
| `lc_content.md` | 語言中心 |
| `oaa_regulations.md` | 教務處 1017 筆 |
| `osa_regulations.md` | 學務處 1501 筆 |

外加兩個法規彙整 xlsx（`北大學術單位法規彙整.xlsx`、`北大行政單位法規彙整.xlsx`）——
少了它們法規仍會載入，但來源連結會全部空白。

`review_qa_*.xlsx` 不會出現，這是刻意排除的（內部審查文件，程式未使用，且 repo 為公開）。

> **這一步的由來**：2026-08 之前 `.gitignore` 排除了體育室那兩個檔，
> 導致正式站「通識與語言中心正常，體育室查無競賽成績與表單」。
> 若日後又有人把它們加回 `.gitignore`，同樣的問題會再發生一次。

### 1.3 commit 與推送

```bash
git commit -m "feat: 整合教務處(OAA)與學務處(OSA)法規；修正跨處室 HitL 修正紀錄"
```

```bash
git remote add origin https://github.com/aintpu/ntpu-ai-assistant.git
```

```bash
git push -u origin main
```

---

## 2. 部署後端（aia-api）

> 五個處室的資料檔現在都已納入版控，所以**從本機上傳或從 GitHub 建置都可以**。
> 下面以本機 `gcloud builds submit` 為例；它會依 `.gcloudignore` 排除
> `config.txt`、`.venv/`、`node_modules/` 等，並保留 `crawler_data/` 與 `.faiss_cache/`。

```bash
cd "C:\Users\chenb\Desktop\ntpu_ai-assistant_202608\ntpu-ai-assistant-main"
```

### 2.1 建置映像檔

```bash
gcloud builds submit --tag asia-east1-docker.pkg.dev/aintpu-aia/aia/aia-api:latest
```

### 2.2 部署到 Cloud Run

金鑰由 Secret Manager 提供 —— `config.txt` 已排除在映像檔外，**沒有這段綁定服務會起不來**。

```bash
gcloud run deploy aia-api --image asia-east1-docker.pkg.dev/aintpu-aia/aia/aia-api:latest --region asia-east1 --service-account aia-runtime@aintpu-aia.iam.gserviceaccount.com --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest --set-env-vars ALLOWED_ORIGINS=https://aia.ntpu.ai --memory 2Gi --cpu 2 --timeout 300 --startup-cpu-boost
```

### 2.3 為什麼帶 `--startup-cpu-boost`

索引若需完整重建，本機實測要 **96 秒**；Cloud Run 啟動期 CPU 若被限速會更久，
超過啟動探測上限就會判定 revision 失敗。開 CPU boost 保留餘裕。

正常情況下映像檔已內含 `.faiss_cache`，啟動只要 **3.7 秒**。
啟動日誌若出現 `索引快取命中` 表示走的是快取；出現 `建立 FAISS 索引中` 則是完整重建
（代表快取與資料檔對不上，會多花 96 秒與一次全量 embedding 費用，但功能正常）。

---

## 3. 部署前端（aia-web）

前端需要在**建置時**就知道後端網址（`NEXT_PUBLIC_*` 會被編進 bundle）。

先取得後端網址：

```bash
gcloud run services describe aia-api --region asia-east1 --format "value(status.url)"
```

```bash
cd "C:\Users\chenb\Desktop\ntpu_ai-assistant_202608\ntpu-ai-assistant-main\front_end\sports-ai-chat"
```

把下面的 `<後端網址>` 換成上一步的輸出：

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions _API_URL=<後端網址>
```

```bash
gcloud run deploy aia-web --image asia-east1-docker.pkg.dev/aintpu-aia/aia/aia-web:latest --region asia-east1 --allow-unauthenticated
```

> `.env.local` 已被前端 `.dockerignore` 的 `.env*` 排除，不會污染正式建置。
> 正式站的 API 位址一律由上面的 `_API_URL` 決定。

---

## 4. 部署後驗證

### 4.1 後端健康檢查

```bash
curl -s https://aia.ntpu.ai/api/health
```

### 4.2 各處室抽測（**體育室務必測到**）

體育室資料是這次最容易漏掉的部分，一定要實際問過：

| 處室 | 測試問題 | 若失敗代表 |
|---|---|---|
| 體育室 | 綜合體育館的借用申請表 | `ALL_files_2.md` 沒上傳 |
| 體育室 | 112 學年度全大運名次 | `all_content_v2.md` 沒上傳 |
| 教務處 | 辦理休學需要哪些程序 | OAA 資料未載入 |
| 學務處 | 宿舍退宿要注意什麼 | OSA 資料未載入 |
| 通識 | 向度通識畢業門檻 | GE 迴歸問題 |
| 語言中心 | 大學英文抵免方式 | LC 迴歸問題 |

### 4.3 檢查啟動日誌

```bash
gcloud run services logs read aia-api --region asia-east1 --limit 30
```

應能看到五個處室的載入筆數，總計 **5178 筆**：

```
[系統] 法規/表單文件切塊完成，共 808 筆
[系統] 使用者修正紀錄 體育室 43 筆
[系統] 通識教育中心 接入 462 筆
[系統] 語言中心 接入 381 筆
[系統] 教務處 接入法規切塊 1017 筆
[系統] 學務處 接入法規切塊 1501 筆
```

**若少了前兩行，就是體育室資料沒進去** —— 回頭確認 `.gcloudignore` 是否被改動。

---

## 5. 出問題時回滾

列出歷史版本：

```bash
gcloud run revisions list --service aia-api --region asia-east1 --limit 5
```

把流量切回上一版（`<前一版本名稱>` 換成上面查到的）：

```bash
gcloud run services update-traffic aia-api --region asia-east1 --to-revisions <前一版本名稱>=100
```

---

## 6. 已知限制

- **OAA/OSA 法規來源連結覆蓋率低**：教務處 20/156、學務處 20/170。
  其餘法規有全文但無連結，前端「參考來源」只會顯示標題。
  這是彙整用的 xlsx 只收錄各 20 筆造成的，需補資料而非改程式。
- **OAA/OSA 沒有最新消息與常見問題**：只接了法規全文。
  問「註冊截止日」「承辦人電話」這類會查無，系統會誠實說明並建議洽詢該處室。
- **`osa_regulations.md` 有 6 筆是「未能抽出全文」的佔位**，只有連結沒有內文。
- **`corrections.md` 寫在容器檔案系統內**：Cloud Run 執行個體是暫時的，
  使用者的修正在執行個體回收後就會消失，且不會同步回 repo。
  要長期保存需改存到 GCS 或資料庫。
