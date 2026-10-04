# ADR-0002 — 關鍵字搜尋用 SQL LIKE，不用向量

Status: Accepted（2026-10-03）

## Context
需要讓 client 依關鍵字找公告、法規、FAQ。規格 08 §10 建議先用 SQL／lexical，向量只能是衍生資料，且要先有 golden set 量測。

## Decision
`search_*` 以 `search_text LIKE`（參數 bind、跳脫萬用字元）比對，空白分隔最多 5 個詞、全部都要符合，搭配處室與日期篩選。

## Alternatives considered
- D1 FTS5：中文斷詞支援有限。
- 向量檢索（Vectorize）：需要 embedding 成本與 golden set 量測，未達規格 08 §6 的啟用條件。

## Security/data impact
全部參數 bind，無 SQL 注入面（有安全測試與 golden set adv-001）。

## Operational impact
不需要額外索引服務。

## Consequences
換說法可能查不到（例如問「獎助學金」但公告寫「獎學金」）。呼叫端（AIA）會先去掉「最新」「公告」等無篩選意義的詞再查。
是否加入語意搜尋，待 golden set 與 model-in-loop eval 量測後再決定。

## References
規格 08 §10、§6；golden set（`evals/golden.json`）
