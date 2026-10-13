# ADR-0010 — 加入商學院（www.aacsb.ntpu.edu.tw）

Status: Accepted（2026-10-13）

## Context
使用者要把商學院加進 MCP。new.ntpu.edu.tw/business 幾乎沒有內容（只有院長簡介約 280 字），學校公告系統也沒有商學院的公告；
商學院實際使用自己的網站 https://www.aacsb.ntpu.edu.tw/（PHP，伺服器端產生 HTML）。

## Decision
- 新增兩個來源，單位代碼 `business`（AIA 端 `cob`，只有 MCP 資料、沒有 FAQ 檔）：
  - `business-site-pages`（adapter `html-pages`）：`page.php?id=N` 一次包含該組所有分頁，每組抓一次（ids=1）再依分頁切成多筆；
    10 組約 61 頁。網站沒有修改時間，`updatedAt` 留空（PageSchema 允許空字串），不以抓取時間冒充來源修訂時間。
  - `business-announcements`（adapter `html-news`，site `aacsb-php`）：最新消息列表沒有分頁、只列最新約 24 則；
    內文 `view.php?id=` 是流水號的 base64。使用者選擇補齊歷史公告：列表以 1 到最新流水號的每個編號當作項目，
    每次最多抓 60 則未收錄的編號（約 2,300 則，約一天補齊）；已刪除的編號回傳空白頁，記入隔離區後不再重抓。重新驗證週期 30 天。
- 請求間隔沿用 HTML 網站的 1 秒；白名單只允許 `/news.php`（id=0、ids=17）、`/view.php`（base64 編號）、`/page.php`（id 數字、ids=1）。
- 系所網站（企管、金融、會計、統計、休運、資管所、國企所等）這次不收（使用者選擇），之後逐一評估。

## Consequences
- 補齊完成前，商學院公告的來源狀態為不完整（INGESTION_INCOMPLETE）。
- 公告附件在商學院網站（/uploads/file/），不在 cms-carrier，附件內容第一階段不讀取，只保留檔名與連結。
