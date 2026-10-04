# ADR-0007 — aia.mcp.ntpu.ai 改由新 MCP 提供

Status: Accepted（2026-10-04）

## Context
`aia.mcp.ntpu.ai` 原本由舊 MCP（repo aintpu/aintpumcp，容器版，3300 份文件）提供。新 MCP 已收錄公告、介紹頁、法規、FAQ。

## Decision
- 舊 MCP 改名 `ntpu-aia-mcp-legacy`，保留 workers.dev 網址可用。
- 網域以 Cloudflare API 的 override 直接轉給新 MCP（`ntpu-aia-mcp`），轉移過程不中斷。
- AIA 正式站的「最新公告」改查新 MCP，失敗時退回本機資料（`MCP_ANNOUNCEMENTS` 開關）。

## Migration/rollback
網域可用同樣方式轉回 legacy；AIA 可設 `MCP_ANNOUNCEMENTS=0` 改回本機資料（見 DEPLOY.md 3.1）。

## Consequences
新 MCP 法規以關鍵字搜尋為主，與舊 MCP 的檢索方式不同；第二階段（法規、FAQ 改查 MCP）需先以 golden set 比較品質。

## References
mcp/ROLLBACK.md、DEPLOY.md 3.1；PR #6–#8
