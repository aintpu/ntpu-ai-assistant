# ADR-0003 — 人工整理檔經 R2 manual/ 匯入

Status: Accepted（2026-10-04）

## Context
法規全文、法規彙整表、各處室常見問答在官網沒有可抓的結構化來源，只有同學與處室整理的檔案（repo 的 `crawler_data/`）。
規格 05 §6 有 `manual_verified` 來源類型，但沒有規定匯入方式。

## Decision
- `scripts/upload-manual.mjs` 把 markdown 原樣上傳到 R2 `manual/`；兩份 xlsx 轉成 `derived/regulation-catalog.json`（只轉格式）。
- 抓取 Worker 新增三種 adapter，**只讀 `manual/` 底下、來源登記過的檔案，不連任何網站**，其後沿用相同的
  raw archive → 驗證 → 雜湊 → 版本 → 發布流程。
- 來源標示 `sourceType: manual_verified`、`trustLevel: verified`，與官網抓取的 `official` 區分；工具說明要求 client 告知使用者。
- 不收錄 `corrections.md`（使用者回饋，未經處室確認）。

## Alternatives considered
- 把檔案打包進 Worker：檔案約 6 MB，且每次更新都要重新部署。
- 由本機直接寫 D1：繞過 raw archive 與版本流程，違反規格 05 §9.1。

## Security/data impact
路徑 allowlist（`crawler_data/` 或 `derived/`、副檔名 md/json、不得有 `..`），大小與 content-type 限制，有安全測試。

## Operational impact
檔案更新後要重新執行上傳；同一來源每天比對一次。

## Migration/rollback
移除來源設定即可；已發布資料依消失政策標為 inactive，不刪除。

## Consequences
資料品質取決於人工整理檔；行政單位法規彙整表目前多數處室只有 20 筆，官方連結覆蓋率偏低。

## References
規格 05 §6、§9.1；PR #4
