-- Private drafts stay separate from runnable bot_skills until their owner reviews them.
CREATE TABLE IF NOT EXISTS bot_skill_candidates (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT NOT NULL REFERENCES bot_tasks(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    encrypted_draft TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    citations TEXT NOT NULL DEFAULT '[]',
    source_hash TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('manual','model','agent','memory_core')),
    extraction_state TEXT NOT NULL DEFAULT 'ready' CHECK(extraction_state IN ('ready','queued','failed')),
    extraction_error TEXT NOT NULL DEFAULT '',
    upstream_task_id TEXT,
    upstream_skill_id TEXT,
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT REFERENCES users(id),
    reviewed_at BIGINT,
    skill_id TEXT REFERENCES bot_skills(id) ON DELETE SET NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_skill_candidates_owner ON bot_skill_candidates(tenant_id,user_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ix_bot_skill_candidates_skill ON bot_skill_candidates(skill_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_bot_skill_candidates_upstream ON bot_skill_candidates(tenant_id,user_id,upstream_task_id,upstream_skill_id);

-- Durable deletion tombstones survive local draft deletion and upstream outages.
CREATE TABLE IF NOT EXISTS bot_skill_cleanup (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    upstream_task_id TEXT NOT NULL,
    upstream_skill_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
    attempts BIGINT NOT NULL DEFAULT 0,
    next_attempt_at BIGINT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_skill_cleanup_pending ON bot_skill_cleanup(status,next_attempt_at);
