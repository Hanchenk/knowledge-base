-- Public OAuth clients are deployment/tenant bound. User grants remain private.
CREATE TABLE IF NOT EXISTS bot_feishu_clients (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
    client_id TEXT NOT NULL DEFAULT '', redirect_uri TEXT NOT NULL DEFAULT '',
    registration_lease TEXT NOT NULL DEFAULT '', lease_until BIGINT NOT NULL DEFAULT 0,
    revision BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_feishu_oauth_states (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), session_hash TEXT NOT NULL,
    browser_hash TEXT NOT NULL, encrypted_verifier TEXT NOT NULL,
    client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_feishu_states_expiry ON bot_feishu_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS bot_feishu_accounts (
    connector_id TEXT PRIMARY KEY REFERENCES bot_connectors(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, encrypted_tokens TEXT NOT NULL,
    access_expires_at BIGINT NOT NULL, refresh_expires_at BIGINT NOT NULL,
    tool_catalog TEXT NOT NULL DEFAULT '[]', enabled BIGINT NOT NULL DEFAULT 1,
    needs_reconnect BIGINT NOT NULL DEFAULT 0, version BIGINT NOT NULL DEFAULT 1,
    refresh_lease TEXT NOT NULL DEFAULT '', refresh_lease_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE(tenant_id,user_id)
);
