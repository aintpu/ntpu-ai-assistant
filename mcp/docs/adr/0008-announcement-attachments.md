# ADR-0008 — 讀取公告附件內容

Status: Accepted（2026-10-08）

## Context
老師問「資訊管理研究所的考試科目」查不到：考科寫在教務處招生簡章的 PDF 附件裡，MCP 只存附件的檔名與連結。
盤點 17 個單位的公告附件共 9,099 個（PDF 4,440、圖片約 4,100、ODT/ODS 約 510），抽樣 60 份 PDF 約 37% 是掃描檔。
使用者決定全部讀取，含個人資料的名單「讀取但不公開」，圖片與掃描檔用 Cloudflare 的看圖模型辨識（資料不離開 Cloudflare）。

## Decision
- 新增來源 `announcement-attachments`（entity_type `attachment`）：附件清單來自已收錄的公告；每次執行最多 40 個、其中圖片最多 15 張；
  專用排程 `5-59/10 * * * *`（與一般排程錯開），一般排程不挑這個來源。
- 白名單新增 `pathRules`：只允許 `https://cms-carrier.ntpu.edu.tw/uploads/<單一檔名>.(pdf|odt|ods|odp|docx|jpg|jpeg|png)`，不得帶查詢參數。
  圖書館、語言中心網站的少數附件（約 40 個）第一階段不處理。
- 文字抽取：PDF 用 unpdf（PDF.js）；ODF／DOCX 自行解壓縮讀 XML（fflate 0.8.3，限制解壓後大小）。
  **不用** Cloudflare `toMarkdown`：實測招生簡章只抽出一半文字、表格（系所考科）全部遺失。
- 圖片 OCR：Workers AI `@cf/mistralai/mistral-small-3.1-24b-instruct`（實測讀得出中文海報、偶有錯字；比 Llama 4 Scout 少漏主標）。
- 掃描型 PDF（平均每頁少於 30 字）第一階段只存檔名與連結（`extracted=false, note=scanned`），第二階段再辨識。
- 個人資料：沿用公告的 `personalDataReason`（模式 all）；命中者記入隔離區、不寫入正式資料，原始檔仍在 R2 可追溯。
- 壞檔、加密、格式不符：只存檔名與連結並記錄原因，不重試；下載或 OCR 失敗一天內不重試。
- 新增唯讀工具 `search_attachments`、`get_attachment`（R0、L0）。

## Consequences
- 第一次補齊約 9,000 個附件，每 10 分鐘 40 個，約 2～3 天。補齊前來源狀態為 stale。
- 文字抽取在 Workers 方案內；OCR 使用 Workers AI 額度，每天有免費額度，超過才收費。
- 附件文字長、雜訊多：AIA 端附件沒有標題加分，排序低於法規、FAQ；回答時附原檔連結，提醒以原檔為準。
- 個資偵測是固定規則，無法保證百分之百；寧可多擋。
