-- OpenChat identities are separate from official-account friends.
CREATE TABLE IF NOT EXISTS openchat_connectors (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 enabled INTEGER NOT NULL DEFAULT 1, account_fingerprint TEXT, account_name TEXT,
 heartbeat_at TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS openchat_rooms (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES openchat_connectors(id),
 external_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'room',
 parent_external_id TEXT, enabled INTEGER NOT NULL DEFAULT 0, enabled_at TEXT, last_message_at INTEGER,
 UNIQUE(connector_id,external_id)
);
CREATE TABLE IF NOT EXISTS openchat_members (
 connector_id TEXT NOT NULL REFERENCES openchat_connectors(id), external_id TEXT NOT NULL,
 display_name TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(connector_id,external_id)
);
CREATE TABLE IF NOT EXISTS openchat_media (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES openchat_connectors(id),
 room_id TEXT NOT NULL REFERENCES openchat_rooms(id), object_key TEXT NOT NULL UNIQUE,
 filename TEXT NOT NULL, mime_type TEXT NOT NULL, kind TEXT NOT NULL,
 bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS openchat_messages (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES openchat_rooms(id),
 external_id TEXT NOT NULL, sender_external_id TEXT NOT NULL, sender_name TEXT NOT NULL,
 is_self INTEGER NOT NULL DEFAULT 0, content_type TEXT NOT NULL, body TEXT NOT NULL,
 timestamp_ms INTEGER NOT NULL, media_id TEXT REFERENCES openchat_media(id),
 UNIQUE(room_id,external_id)
);
CREATE TABLE IF NOT EXISTS openchat_outbox (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES openchat_connectors(id),
 room_id TEXT NOT NULL REFERENCES openchat_rooms(id), request_id TEXT NOT NULL,
 body_hash TEXT NOT NULL, body TEXT NOT NULL, media_id TEXT REFERENCES openchat_media(id),
 state TEXT NOT NULL DEFAULT 'queued', lease_token TEXT, lease_until TEXT,
 remote_ids TEXT, error TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
 updated_at TEXT NOT NULL, UNIQUE(connector_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_openchat_messages_time ON openchat_messages(room_id,timestamp_ms,id);
CREATE INDEX IF NOT EXISTS idx_openchat_outbox_claim ON openchat_outbox(connector_id,state,created_at);
