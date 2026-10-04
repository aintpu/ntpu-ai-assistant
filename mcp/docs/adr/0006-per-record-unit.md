# ADR-0006 — 一個來源的資料可分屬多個處室

Status: Accepted（2026-10-04）

## Context
16 個處室的 FAQ 合成一個來源（`office-faqs`），法規彙整表涵蓋多個單位；原設計假設一個來源只屬一個處室。

## Decision
`AdapterRecord` 可帶自己的 `unit`；`stable_key` 為「處室:編號」、`entities.source_unit` 用資料的處室。
來源設定以 `recordUnits` 列出涵蓋的處室，供工具的處室篩選與 freshness 使用。
FAQ 某個處室檔案讀不到時，其他處室照樣更新，但該次不算完整走完，避免讀不到的處室被誤判下架。

## Consequences
`get_regulation`、`get_faq` 以編號查詢、不必先知道處室（編號在同類資料內唯一）。

## References
PR #4
