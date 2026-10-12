CREATE TABLE IF NOT EXISTS bot_tasks (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
    prompt TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    options TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL DEFAULT '',
    citations TEXT NOT NULL DEFAULT '[]', web_sources TEXT NOT NULL DEFAULT '[]',
    error TEXT, worker_token TEXT, lease_until BIGINT, attempt BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE(tenant_id,user_id,request_id)
);
CREATE TABLE IF NOT EXISTS bot_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES bot_tasks(id),
    kind TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_artifacts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES bot_tasks(id),
    name TEXT NOT NULL, storage_key TEXT NOT NULL, size BIGINT NOT NULL,
    created_at BIGINT NOT NULL, UNIQUE(task_id,name)
);
CREATE TABLE IF NOT EXISTS bot_connectors (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    description TEXT NOT NULL, encrypted_config TEXT NOT NULL,
    enabled BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_actions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES bot_tasks(id),
    connector_id TEXT NOT NULL REFERENCES bot_connectors(id), fingerprint TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    result TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE(task_id,connector_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS bot_skills (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    description TEXT NOT NULL, instructions TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_tasks_owner ON bot_tasks(tenant_id,user_id,created_at);
CREATE INDEX IF NOT EXISTS ix_bot_tasks_queue ON bot_tasks(status,lease_until);
CREATE INDEX IF NOT EXISTS ix_bot_events_task ON bot_events(task_id,created_at,id);
CREATE INDEX IF NOT EXISTS ix_bot_actions_task ON bot_actions(task_id,status);
