-- 同一則公告可能同時刊登在多個處室（相同 Strapi _id）。為了讓每個處室各自追蹤
-- 版本、消失政策與來源，公告的 stable_key 改為「處室代碼:_id」，entities.id 跟著改。
-- 只改 key，不動內容、版本或 hash；舊版本紀錄的 entity_id 一併更新以保持對應。

UPDATE record_versions
SET entity_id = 'announcement:' || (
    SELECT e.source_unit || ':' || e.stable_key FROM entities e WHERE e.id = record_versions.entity_id
  )
WHERE entity_type = 'announcement'
  AND entity_id IN (SELECT id FROM entities WHERE entity_type = 'announcement' AND instr(stable_key, ':') = 0);

UPDATE entities
SET id = entity_type || ':' || source_unit || ':' || stable_key,
    stable_key = source_unit || ':' || stable_key
WHERE entity_type = 'announcement' AND instr(stable_key, ':') = 0;

-- 排程每次只跑一個來源：開始時先記下嘗試時間，避免同一來源被重複挑選。
ALTER TABLE sources ADD COLUMN last_started_at TEXT;
