# ADR-0001 — 使用 generic entities 表

Status: Accepted（2026-10-03）

## Context
需要儲存公告、介紹頁，之後再加入法規與常見問答。各類型欄位差異大，且 schema 仍在演進。

## Decision
所有 canonical 資料存在同一張 `entities` 表（`entity_type` + `stable_key` 唯一），內容放 `payload_json`，
另外衍生 `title`、`search_text` 供查詢。每種類型有自己的 Zod schema（`src/shared/schemas.ts`），寫入前與讀出後都驗證。

## Alternatives considered
- 每種類型一張強型別資料表（規格 06 §9）：查詢與約束較嚴謹，但每加一種類型都要 migration。

## Security/data impact
讀出時再驗證 payload，不符合 schema 的資料不回傳（寧可不答）。

## Operational impact
新增類型不需要 migration（法規、FAQ 即是如此加入）。

## Migration/rollback
日後若改用強型別表，可用 forward migration 從 `payload_json` 搬移。

## Consequences
欄位層級的 DB 約束較少，正確性依賴 schema 驗證與測試。

## References
規格 05 §17、06 §9
