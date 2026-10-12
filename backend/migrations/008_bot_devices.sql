CREATE TABLE IF NOT EXISTS bot_devices (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_title TEXT NOT NULL,
    active BIGINT NOT NULL DEFAULT 1, last_seen BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_devices_owner ON bot_devices(tenant_id,user_id);
CREATE TABLE IF NOT EXISTS bot_pairings (
    code_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL,
    device_id TEXT REFERENCES bot_devices(id)
);
CREATE TABLE IF NOT EXISTS bot_local_execution (
    task_id TEXT PRIMARY KEY REFERENCES bot_tasks(id), device_id TEXT NOT NULL REFERENCES bot_devices(id),
    origin TEXT NOT NULL, session_id TEXT, turn_key TEXT,
    last_seq BIGINT NOT NULL DEFAULT 0, last_hash TEXT NOT NULL DEFAULT '',
    cancel_ack BIGINT NOT NULL DEFAULT 0,
    UNIQUE(device_id,session_id,turn_key)
);
CREATE INDEX IF NOT EXISTS ix_bot_local_device ON bot_local_execution(device_id,task_id);
