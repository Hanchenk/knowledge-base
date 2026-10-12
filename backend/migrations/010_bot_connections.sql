CREATE TABLE IF NOT EXISTS bot_connections (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    workspace_title TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    device_id TEXT REFERENCES bot_devices(id)
);
CREATE INDEX IF NOT EXISTS ix_bot_connections_expiry ON bot_connections(expires_at);
