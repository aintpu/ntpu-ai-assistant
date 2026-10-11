-- 查詢流程紀錄（老師建議 五-1，使用者 2026-10-11 決定長期保存）。
-- 後端每個結構化事件（guardrail、rewrite_check、answer、feedback…）一列；payload_json 是完整事件。
-- 使用者問題與回答在後端寫入前已做個資遮罩（redact_sensitive_text）。
CREATE TABLE IF NOT EXISTS query_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  message_id TEXT,
  conversation_id TEXT,
  raw_query TEXT,
  selected_office TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_query_events_message ON query_events(message_id);
CREATE INDEX IF NOT EXISTS idx_query_events_conversation ON query_events(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_query_events_ts ON query_events(ts);
