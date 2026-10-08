# Architecture Decision Records

依 AI4X MCP Core 12 規格 09 §19：偏離或擴充規格的架構決策都記錄在這裡。

| # | 決策 | 狀態 | 與規格的關係 |
|---|---|---|---|
| [0001](0001-generic-entities-table.md) | 使用 generic `entities` 表 | Accepted | 規格 05 §17 允許的起步做法 |
| [0002](0002-lexical-search.md) | 關鍵字搜尋用 SQL LIKE，不用向量 | Accepted | 符合規格 08 §10 |
| [0003](0003-manual-verified-sources.md) | 人工整理檔經 R2 `manual/` 匯入 | Accepted | 擴充：規格 05 §6 有 `manual_verified` 類型，未規定匯入方式 |
| [0004](0004-nullable-source-url.md) | 沒有官方連結時 `sourceUrl` 為 null | Accepted | **偏離**規格 06 §5（`sourceUrl` 必填） |
| [0005](0005-one-source-per-run.md) | 每次排程只處理一個到期來源 | Accepted | 擴充：規格 05 §22.1 建議有界並行 |
| [0006](0006-per-record-unit.md) | 一個來源的資料可分屬多個處室 | Accepted | 擴充 |
| [0007](0007-domain-cutover.md) | `aia.mcp.ntpu.ai` 改由新 MCP 提供 | Accepted | 營運決策 |
| [0008](0008-announcement-attachments.md) | 讀取公告附件內容（PDF、ODF、圖片 OCR） | Accepted | 擴充；個資「讀取但不公開」 |
