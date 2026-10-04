# 維運手冊（Operator runbook）

## 資源

| 環境 | 抓取 Worker | MCP Worker | D1 | R2 |
|---|---|---|---|---|
| production | `ntpu-aia-ingest` | `ntpu-aia-mcp`（`aia.mcp.ntpu.ai`） | `ntpu-aia-canonical` | `ntpu-aia-raw` |
| staging | `ntpu-aia-ingest-staging` | `ntpu-aia-mcp-staging`（workers.dev） | `ntpu-aia-canonical-staging` | `ntpu-aia-raw-staging` |

只操作上表資源；同一個 Cloudflare 帳號裡的其他 Worker、網域（包含 `aia.ntpu.ai`）不要動。

## 每日檢查

```bash
curl -s https://aia.mcp.ntpu.ai/health
```

- `status: ok`，每個來源 `state: fresh`、`lastRunStatus: success`、`quarantinedCount: 0`。
- 抓取 Worker 每 10 分鐘觸發一次、每次處理一個到期來源；每個來源約每 20 小時重抓。28 個來源輪完約 5 小時。

## 常見狀況

| 症狀 | 可能原因 | 處理 |
|---|---|---|
| 某來源 `stale` | 學校網站暫時錯誤；或抓取一直失敗 | 查 D1 `ingestion_items` 最新幾筆的 `error_code`；暫時錯誤會在 15 分鐘後重試 |
| `FETCH_HTTP_ERROR` / `DEPENDENCY_UNAVAILABLE` 持續 | 學校擋 Cloudflare 或改網址 | 確認官網是否改版；不要為了消除錯誤放寬 allowlist |
| `quarantinedCount > 0` | 資料驗證不過（缺標題等） | 看 `ingestion_items` 隔離原因；**不可補造欄位或放寬驗證** |
| 法規/FAQ 沒更新 | 人工整理檔沒有重新上傳 | `npm run manual:upload -- --env production`，等下一輪抓取 |
| Cron 不觸發 | Cron 註冊異常 | 重新部署整個 `ntpu-aia-ingest`（2026-10-03 發生過，重新部署即恢復） |

查詢 D1（唯讀）：

```bash
npx wrangler d1 execute ntpu-aia-canonical --remote \
  --command "SELECT source_id,status,error_code,started_at FROM ingestion_items ORDER BY started_at DESC LIMIT 10"
```

## 部署

1. PR 合併到 `main` 只會跑 `mcp-ci.yml`（測試與 dry-run），**不會部署**。production 手動部署：`npx wrangler deploy -c wrangler.ingest.jsonc` / `-c wrangler.mcp.jsonc`；staging 用 GitHub Actions 的 **Deploy MCP to staging**。
2. 部署後跑 smoke：`/health`、`tools/list` 有 8 個工具、每個 search 工具各查一次。
3. 在 `docs/releases/` 新增一筆上線紀錄（範本見 `docs/releases/README.md`）。

## 還原

- 程式：Cloudflare 後台 Worker → Deployments → 回到上一個版本（或 `npx wrangler rollback --name <worker>`）。
- 整個 MCP 合併：見 `../ROLLBACK.md`。
- AIA 聊天機器人不再用 MCP：把 `MCP_ANNOUNCEMENTS` 設為 `0`，會改回本機資料。
- D1、R2 資料不刪除；版本紀錄在 `record_versions`，原始回應在 R2 `raw/`。
