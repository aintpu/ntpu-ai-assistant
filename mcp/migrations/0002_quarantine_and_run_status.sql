-- 來源狀態語意（修正）：
--   last_success_at  = 最近一次「完整成功」：所有頁面都抓到、沒有抓取／解析／寫入錯誤。
--   last_attempt_at  = 最近一次執行（不論結果）。
--   last_run_status  = 最近一次執行結果：success / partial / failed。
-- 部分成功時已寫入的資料保留，但 last_success_at 不更新，/health 與 MCP 會顯示 INGESTION_PARTIAL。
ALTER TABLE sources ADD COLUMN last_attempt_at TEXT;

-- 驗證不通過的來源資料不寫入正式資料，改記在這裡，可追溯到原始檔（規格 06 §15、§37）。
-- 之後同一筆資料通過驗證並寫入，就會從這裡移除。
CREATE TABLE quarantined_records (
  source_id TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_snapshot_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_run_id TEXT NOT NULL,
  PRIMARY KEY (source_id, stable_key),
  FOREIGN KEY(source_id) REFERENCES sources(id)
);

ALTER TABLE ingestion_runs ADD COLUMN quarantined_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_items ADD COLUMN records_quarantined INTEGER NOT NULL DEFAULT 0;

-- 依來源規則排除、不是本實體類型的項目（例如 strapi 的 banner 輪播圖），只計數，不算失敗。
ALTER TABLE ingestion_runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_items ADD COLUMN records_skipped INTEGER NOT NULL DEFAULT 0;
