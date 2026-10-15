CREATE TABLE IF NOT EXISTS studio_inputs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    kind TEXT NOT NULL, mime_type TEXT NOT NULL, storage_key TEXT NOT NULL,
    size BIGINT NOT NULL, extracted_text TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_requests (
    project_id TEXT NOT NULL REFERENCES studio_projects(id), request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, PRIMARY KEY(project_id,request_id)
);
CREATE TABLE IF NOT EXISTS studio_request_inputs (
    project_id TEXT NOT NULL REFERENCES studio_projects(id), request_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES studio_inputs(id), role TEXT NOT NULL DEFAULT 'reference', position BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id,request_id,attachment_id)
);
CREATE TABLE IF NOT EXISTS studio_job_options (
    job_id TEXT PRIMARY KEY REFERENCES studio_jobs(id), operation TEXT NOT NULL DEFAULT 'generate',
    quality TEXT NOT NULL DEFAULT 'auto', style TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_studio_inputs_owner ON studio_inputs(tenant_id,user_id,created_at);
