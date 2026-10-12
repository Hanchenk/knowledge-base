CREATE TABLE IF NOT EXISTS studio_projects (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_messages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id),
    request_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]', web_sources TEXT NOT NULL DEFAULT '[]',
    tool_calls TEXT NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL,
    UNIQUE(project_id,request_id,role)
);
CREATE TABLE IF NOT EXISTS studio_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL,
    size TEXT NOT NULL, seconds BIGINT NOT NULL DEFAULT 0,
    provider_payload TEXT NOT NULL, provider_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued', progress BIGINT NOT NULL DEFAULT 0,
    error TEXT, available_at BIGINT NOT NULL, lease_until BIGINT, worker_token TEXT,
    poll_count BIGINT NOT NULL DEFAULT 0, poll_errors BIGINT NOT NULL DEFAULT 0, started_at BIGINT, created_at BIGINT NOT NULL,
    finished_at BIGINT, UNIQUE(project_id,request_id,kind)
);
CREATE TABLE IF NOT EXISTS studio_assets (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES studio_jobs(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL, mime_type TEXT NOT NULL, storage_key TEXT NOT NULL,
    size BIGINT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_studio_projects_owner ON studio_projects(tenant_id,user_id,updated_at);
CREATE INDEX IF NOT EXISTS ix_studio_messages_project ON studio_messages(project_id,created_at);
CREATE INDEX IF NOT EXISTS ix_studio_jobs_queue ON studio_jobs(status,available_at,lease_until);
CREATE INDEX IF NOT EXISTS ix_studio_jobs_project ON studio_jobs(project_id,created_at);
CREATE INDEX IF NOT EXISTS ix_studio_assets_job ON studio_assets(job_id);
