CREATE TABLE IF NOT EXISTS inspiration_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    started_at BIGINT NOT NULL,
    finished_at BIGINT,
    score BIGINT CHECK (score BETWEEN 0 AND 20)
);
CREATE INDEX IF NOT EXISTS ix_inspiration_runs_owner ON inspiration_runs(tenant_id,user_id,started_at);
CREATE TABLE IF NOT EXISTS inspiration_scores (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    best_score BIGINT NOT NULL CHECK (best_score BETWEEN 0 AND 20),
    achieved_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS ix_inspiration_scores_rank ON inspiration_scores(tenant_id,best_score DESC,achieved_at,user_id);
