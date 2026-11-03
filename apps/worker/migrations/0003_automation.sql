-- Explicitly approved OpenChat policies; personal 1:1 conversations are excluded.
CREATE TABLE IF NOT EXISTS openchat_automation_policies (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, room_id TEXT NOT NULL,
 name TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL,
 daily_limit INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
 revision INTEGER NOT NULL DEFAULT 1, enabled_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_by TEXT, consent_version TEXT
);
CREATE TABLE IF NOT EXISTS openchat_automation_runs (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL,
 source_key TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL,
 outbox_id TEXT, error_code TEXT, created_at TEXT NOT NULL,
 UNIQUE(policy_id,policy_revision,source_key)
);
CREATE INDEX IF NOT EXISTS idx_oc_auto_reserved ON openchat_automation_runs(status,created_at);
CREATE INDEX IF NOT EXISTS idx_oc_auto_day ON openchat_automation_runs(policy_id,day);
CREATE INDEX IF NOT EXISTS idx_oc_auto_active ON openchat_automation_policies(connector_id,status);
CREATE TABLE IF NOT EXISTS openchat_creations (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 status TEXT NOT NULL, square_mid TEXT, chat_mid TEXT, room_id TEXT,
 created_at TEXT NOT NULL
);
ALTER TABLE openchat_outbox ADD COLUMN automation_id TEXT;
ALTER TABLE openchat_outbox ADD COLUMN automation_revision INTEGER;
