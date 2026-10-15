-- Private, durable MemoryKnowledge resources. Provider IDs never come from a browser.
CREATE TABLE IF NOT EXISTS bot_knowledge_assets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK(kind IN ('wiki','code_graph')),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    document_ids TEXT NOT NULL DEFAULT '[]',
    repository_url TEXT NOT NULL DEFAULT '',
    source_snapshot TEXT NOT NULL DEFAULT '[]',
    provider_id TEXT NOT NULL DEFAULT '',
    create_uncertain BIGINT NOT NULL DEFAULT 0,
    create_branch TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    deleted BIGINT NOT NULL DEFAULT 0,
    attempts BIGINT NOT NULL DEFAULT 0,
    available_at BIGINT NOT NULL DEFAULT 0,
    lease_token TEXT NOT NULL DEFAULT '',
    lease_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_knowledge_owner ON bot_knowledge_assets(tenant_id,user_id,deleted,updated_at);
CREATE INDEX IF NOT EXISTS ix_bot_knowledge_queue ON bot_knowledge_assets(status,available_at,lease_until);
-- Upstream deduplicates CodeGraph by repository and team. Keep exactly one live
-- local owner resource until its tombstone has finished the remote purge.
CREATE UNIQUE INDEX IF NOT EXISTS ix_bot_knowledge_repository ON bot_knowledge_assets(tenant_id,user_id,lower(repository_url)) WHERE kind='code_graph' AND status!='deleted';
