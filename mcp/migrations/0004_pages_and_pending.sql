-- HTML 公告網站一次只抓有限數量的內文；沒抓完的數量記在 pending_count，
-- 排程會優先接著抓這個來源。
ALTER TABLE sources ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0;
-- 執行摘要多記「留到下一次」的內文數。
ALTER TABLE ingestion_runs ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0;
