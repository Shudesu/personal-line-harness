-- Managed sessions retain history when revoked; only credentials are erased.
ALTER TABLE openchat_connectors ADD COLUMN mode TEXT NOT NULL DEFAULT 'external' CHECK(mode IN ('external','managed'));
ALTER TABLE openchat_connectors ADD COLUMN managed_token TEXT;
ALTER TABLE openchat_connectors ADD COLUMN bridge_token_hash TEXT;
ALTER TABLE openchat_connectors ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_openchat_managed_active ON openchat_connectors(mode) WHERE mode='managed' AND enabled=1;
