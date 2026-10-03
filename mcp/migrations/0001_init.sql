-- NTPU AIA canonical store（規格 06：sources / entities / record_versions / ingestion_runs / ingestion_items）
-- 所有時間欄位皆為 UTC ISO-8601 字串。

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  source_unit TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'official',
  last_success_at TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 正式資料（目前版本）。title / search_text 由 payload 衍生，只用於查詢，不另作事實來源。
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  source_unit TEXT NOT NULL,

  payload_json TEXT NOT NULL,
  title TEXT NOT NULL,
  search_text TEXT NOT NULL,

  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  raw_snapshot_key TEXT NOT NULL,

  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  verified_at TEXT NOT NULL,

  published_at TEXT,
  effective_at TEXT,

  -- 來源消失政策（規格 37）：連續 N 次完整成功的抓取都沒看到才標記 inactive，不做硬刪除。
  status TEXT NOT NULL DEFAULT 'active',
  missing_runs INTEGER NOT NULL DEFAULT 0,
  last_seen_run_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY(source_id) REFERENCES sources(id),
  UNIQUE(entity_type, stable_key)
);

CREATE INDEX idx_entities_type_unit_published
  ON entities(entity_type, source_unit, status, published_at DESC);
CREATE INDEX idx_entities_source ON entities(source_id);
CREATE INDEX idx_entities_hash ON entities(content_hash);

-- 被取代的舊版本，不可變更。
CREATE TABLE record_versions (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,

  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_snapshot_key TEXT NOT NULL,

  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL,

  UNIQUE(entity_type, entity_id, version)
);

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,

  status TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  published_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,

  error_summary_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ingestion_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target TEXT NOT NULL,

  status TEXT NOT NULL,
  http_status INTEGER,
  raw_snapshot_key TEXT,
  raw_hash TEXT,

  records_parsed INTEGER NOT NULL DEFAULT 0,
  records_published INTEGER NOT NULL DEFAULT 0,
  records_unchanged INTEGER NOT NULL DEFAULT 0,

  error_code TEXT,
  error_message TEXT,

  started_at TEXT NOT NULL,
  finished_at TEXT,

  FOREIGN KEY(run_id) REFERENCES ingestion_runs(id),
  FOREIGN KEY(source_id) REFERENCES sources(id)
);

CREATE INDEX idx_ingestion_items_run ON ingestion_items(run_id);
