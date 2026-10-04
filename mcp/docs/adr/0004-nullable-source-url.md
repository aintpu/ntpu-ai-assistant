# ADR-0004 — 沒有官方連結時 sourceUrl 為 null

Status: Accepted（2026-10-04）— **偏離規格**

## Context
規格 06 §5 的 provenance 定義 `sourceUrl: z.string().url()`（必填）。
教務處 136、學務處 146 份法規全文在人工整理檔與彙整表中都找不到官方檔案連結。
原本退回 GitHub 上的原始檔連結，但對使用者沒有意義（是整份 markdown），也容易被誤認為非官方資料。

## Decision
- 沒有官方連結時，provenance 與資料的 `sourceUrl` 為 `null`（DB 欄位 NOT NULL，存空字串、讀出轉 null，不改資料表）。
- 查詢結果另提供純文字 `sourceName`（例如「學生事務處法規（人工整理資料）」），查詢時產生、不存入資料。
- 工具說明要求 client：`sourceUrl` 為 null 時只用 `sourceName` 以文字標示來源，不得自行產生連結。
- 追溯仍可用每筆資料的 `sourceFile`、`sourceId`、`contentHash`、`version` 與 R2 原始檔。

## Alternatives considered
- 指向 GitHub 原始檔（原做法）：符合格式，但對使用者沒有意義。
- 指向處室官網的法規列表頁：符合規格且對使用者有意義，但需要逐一確認各處室列表頁網址；**列為後續改善選項**。
- 補齊法規彙整表：根本解法，可讓多數法規有官方連結（見 ADR-0003 Consequences）。

## Security/data impact
不影響安全；provenance 其他欄位仍完整，有測試確認沒有任何 GitHub 連結、空連結只出現在預期的 282 筆。

## Operational impact
彙整表補齊並重新上傳後，配對到連結的法規會自動有 `sourceUrl`。

## Migration/rollback
改回必填只需在 adapter 恢復預設網址並放回 schema 限制。

## Consequences
provenance consumer 必須能處理 `sourceUrl: null`（AIA 後端已處理）。

## References
規格 06 §5、§12；PR #5
