# ADR-0005 — 每次排程只處理一個到期來源

Status: Accepted（2026-10-03）

## Context
Cloudflare Workers 每次執行有子請求數、D1 查詢數與時間上限。最大的來源（語言中心）一次約 500 個子請求。

## Decision
Cron 每 10 分鐘觸發，每次只挑一個到期來源：從沒跑過的優先，其次是上次內文沒抓完的（15 分鐘後接著抓），
再來是超過 20 小時沒跑的。HTML 來源每次最多抓 60 則內文，其餘記在 `pending_count`。

## Alternatives considered
- 一次跑全部來源（規格 05 §22 的 orchestrator）：會超過單次執行上限。

## Operational impact
- 首次抓齊約 3.5 小時（語言中心另需數批）；同一來源每天更新一次。
- 部署新 Worker 後若排程不觸發，需要重新部署整個 Worker（只重新註冊 trigger 無效，2026-10-03 production 實際遇過）。

## Consequences
資料最多延遲約一天；`/health` 的 freshness 以 48 小時為過期門檻。

## References
規格 05 §22–24
