# 2026-10-04 收錄法規與常見問答、aia.mcp.ntpu.ai 切到新 MCP

| 項目 | 值 |
|---|---|
| Git commit | `805da50`（PR #4）、`163bdea`（PR #5） |
| PR | #4 收錄法規與各處室常見問答；#5 沒有官方連結時不提供網址 |
| ntpu-aia-ingest 版本 | `7895dd06-e0f5-430d-8841-bce742287bf9`（13:23）→ `64b86f8f-f6d8-4bff-8c00-a622e8375039`（13:33） |
| ntpu-aia-mcp 版本 | `32b9a311-08f2-46b5-8dfa-35f0f6aa5941`（13:23）→ `894e4805-f0b5-426a-b5a0-229a62f7e4db`（13:33） |
| D1 migration | 無 |
| 部署者 / 時間（台北） | 盧信廷 / 2026-10-04 13:23、13:33 |

## 變更

- 新增 7 個人工整理來源（5 份處室法規、法規彙整表、各處室常見問答），`manual_verified` / `verified`，從 R2 `manual/` 讀取（ADR-0003）。
- 新增 `search_regulations`、`get_regulation`、`search_faqs`、`get_faq`。
- 沒有官方連結時 `sourceUrl` 為 `null`，只顯示來源名稱文字（ADR-0004）。
- `aia.mcp.ntpu.ai` 綁到 `ntpu-aia-mcp`；舊服務改名 `ntpu-aia-mcp-legacy`，只留 workers.dev（ADR-0007）。

## 驗證（2026-10-04 14:5x，規格 11 §10）

- `/health`：`status: ok`，28 個來源全部 `fresh` / `success`，`quarantinedCount` 皆 0。
- `tools/list`：8 個工具，與登記表一致。
- `search_announcements`、`search_pages`、`search_regulations`、`search_faqs`（limit 3）各回 3 筆，皆附 provenance。
- AIA 正式站問「教務處最新公告」：回 2026-10-02【智財權宣導】，與學校官網一致，附公告資料更新時間（AIA PR #8 之後）。

## 還原方式

`npx wrangler rollback --name ntpu-aia-mcp` / `--name ntpu-aia-ingest` 回到上一版；網域切換的還原見 ADR-0007。
D1、R2 資料不需還原（只新增）。

## 已知問題

- 行政單位法規彙整表多數處室只有 20 筆，待補齊。
- 雲端重複執行（idempotent）尚未在 production 觀察完整一輪。
