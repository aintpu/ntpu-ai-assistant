# 規格驗收清單（AI4X MCP Core 12）

狀態：✅ 完成並有證據、🟡 部分完成、⬜ 未做。證據指向 repo 檔案或上線紀錄。

| 規格 | 項目 | 狀態 | 證據 |
|---|---|---|---|
| 06 §6–8 | 來源 allowlist、SSRF、逾時/大小/content-type | ✅ | `src/ingestion/url-policy.ts`、`tests/security/` |
| 06 §9 | 原始回應存 R2、不可覆寫 | ✅ | `src/ingestion/raw-archive.ts` |
| 06 §12–15 | schema 驗證、SHA-256、版本紀錄 | ✅ | `src/db/canonical-store.ts`、`tests/integration/` |
| 06 §5 | provenance | 🟡 | 人工檔 `sourceUrl` 可為 null，刻意偏離（ADR-0004） |
| 06 §22 | 消失政策（不刪除） | ✅ | `run-ingestion.ts`、ADR-0006 |
| 07 §10 | 工具登記表、公開 v1 政策 | ✅ | `src/mcp/tool-registry.ts`、`/about` |
| 08 §2 | 唯讀、R0、L0、無 scope | ✅ | 登記表；eval smoke 檢查查詢不改資料 |
| 10 §4 | golden set（8 類） | ✅ | `evals/golden.json`、`tests/eval/smoke.test.ts` |
| 10 §7 | contract snapshot | ✅ | `tests/contract/` |
| 10 §10 | model-in-loop eval | ⬜ | 尚未實作；smoke 不代表模型選工具準確率 |
| 10 | lint / typecheck / 測試 | ✅ | `npm test`（Biome + 183 tests）、`npm run typecheck` |
| 11 §10 | production smoke | ✅ | `releases/2026-10-04-manual-sources.md` |
| 11 | 上線紀錄 | ✅ | `releases/` |
| 11 | 還原說明 | ✅ | `../ROLLBACK.md`、`runbook.md` |
| 12 | ADR | ✅ | `adr/` |
| 12 | 負責人 | ✅ | `ownership.md` |
| 12 | 維運手冊、工具說明 | ✅ | `runbook.md`、`tools.md` |
| — | production idempotent 重跑觀察 | 🟡 | 測試涵蓋；雲端完整一輪待觀察 |
