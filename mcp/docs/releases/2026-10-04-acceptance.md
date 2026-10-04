# 2026-10-04 規格驗收：工具登記表、contract snapshot、lint、golden set、ADR、文件

| 項目 | 值 |
|---|---|
| Git commit | `830d56c`（PR #9） |
| PR | #9 補齊規格驗收 |
| ntpu-aia-ingest 版本 | 未重新部署（維持 `64b86f8f-f6d8-4bff-8c00-a622e8375039`） |
| ntpu-aia-mcp 版本 | `894e4805-f0b5-426a-b5a0-229a62f7e4db` → `7e6cf273-2ddf-4894-9199-09c08cbdffc3` |
| D1 migration | 無 |
| 部署者 / 時間（台北） | 盧信廷 / 2026-10-04 |

## 變更

- 工具只從登記表註冊（R0、L0、唯讀、無 scope）；`/about` 顯示登記表與負責人。
- 工具名稱、說明、schema、回應不變（contract snapshot 鎖定）。
- 新增 lint、golden set smoke、ADR 0001–0007、維運文件。

## 驗證

- 部署前 main 上 `npm test`：lint + 183 tests 通過。
- `/about`：`toolRegistry` 8 筆，四個負責人角色皆為盧信廷。
- `/health`：`status: ok`，28/28 來源 `fresh`。
- `search_announcements`（unit=oaa）最新一則為 2026-10-02【智財權宣導】，與官網一致。
- wrangler 顯示「No targets deployed」：設定檔不含網域路由，`aia.mcp.ntpu.ai` 綁定在 Cloudflare 上保留，實測已服務新版本。

## 還原方式

`npx wrangler rollback --name ntpu-aia-mcp` 回到 `894e4805-…`。

## 已知問題

- model-in-loop eval 尚未實作。
- 雲端 idempotent 重跑待觀察。
