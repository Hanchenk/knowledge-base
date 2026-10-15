-- The upstream skill asset catalog requires real owner/team/agent entities.
-- Each owner gets a private native team; provider instances never share mappings.
CREATE TABLE IF NOT EXISTS core_skill_registry (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    provider_namespace TEXT NOT NULL,
    registration_nonce TEXT NOT NULL,
    encrypted_owner_key TEXT NOT NULL,
    native_user_id TEXT NOT NULL DEFAULT '',
    native_team_id TEXT NOT NULL DEFAULT '',
    native_agent_id TEXT NOT NULL DEFAULT '',
    ready BIGINT NOT NULL DEFAULT 0,
    lease_token TEXT NOT NULL DEFAULT '',
    lease_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(tenant_id,user_id,provider_namespace)
);

-- Retained when a draft is removed, so durable cleanup keeps its original scope.
CREATE TABLE IF NOT EXISTS bot_skill_provider_receipts (
    id TEXT PRIMARY KEY,
    registry_id TEXT NOT NULL REFERENCES core_skill_registry(id),
    provider_namespace TEXT NOT NULL,
    source_task_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    extraction_state TEXT NOT NULL DEFAULT 'prepared' CHECK(extraction_state IN ('prepared','acknowledged','uncertain')),
    upstream_task_id TEXT NOT NULL DEFAULT '',
    submitted_at BIGINT NOT NULL DEFAULT 0
);
