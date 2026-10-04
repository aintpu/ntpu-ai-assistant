# 工具說明（Tool reference）

端點：`POST https://aia.mcp.ntpu.ai/mcp`（MCP Streamable HTTP，stateless，JSON 回應，不需登入）。
完整 input/output schema 以 `tests/contract/__snapshots__/` 為準；名稱、說明或 schema 改變時快照測試會失敗。

所有工具：版本 1.0.0、風險 R0、資料等級 L0、唯讀、不需要 scope（登記表 `src/mcp/tool-registry.ts`）。
每筆資料都附 `provenance`（sourceId、sourceType、trustLevel、version、verifiedAt、contentHash、sourceUrl）；
回應附 `freshness`（各來源最後成功時間）與 `warnings`。查無資料回 `count: 0, noResult: true` 或 `found: false`，不是錯誤。

| 工具 | 用途 | 參數 |
|---|---|---|
| `search_announcements` | 搜尋各處室官網公告，新到舊 | `keyword?`（空白分隔最多 5 詞，全部符合）、`unit?`、`fromDate?`/`toDate?`（YYYY-MM-DD，UTC）、`limit` 1–20，預設 10 |
| `get_announcement` | 取一則公告全文與附件 | `id`、`unit?` |
| `search_pages` | 搜尋校長室、副校長室介紹頁 | `keyword?`、`unit?`、`limit` |
| `get_page` | 取介紹頁全文 | `id` |
| `search_regulations` | 搜尋法規（名稱、標籤、全文） | `keyword?`、`unit?`、`limit` |
| `get_regulation` | 取法規全文 | `id` |
| `search_faqs` | 搜尋各處室常見問答 | `keyword?`、`unit?`、`limit` |
| `get_faq` | 取一則問答 | `id` |

注意：

- 公告日期是 UTC；學校的「台灣 00:00」存成前一天 16:00Z，顯示給使用者前要換成台灣時間。
- 法規、常見問答是人工整理檔（`sourceType: manual_verified`），沒有官方連結時 `sourceUrl` 為 `null`（ADR-0004），只顯示來源名稱文字。
- 錯誤訊息只有 `INVALID_ARGUMENT` 這類代碼與簡短說明，不含 SQL 或堆疊。

範例：

```bash
curl -s -X POST https://aia.mcp.ntpu.ai/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_announcements","arguments":{"unit":"oaa","limit":3}}}'
```
