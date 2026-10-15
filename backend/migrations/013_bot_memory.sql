CREATE TABLE IF NOT EXISTS bot_memory_settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  capture INTEGER NOT NULL DEFAULT 1,
  revision BIGINT NOT NULL DEFAULT 1,
  synced_revision BIGINT NOT NULL DEFAULT 0,
  sync_token TEXT NOT NULL DEFAULT '',
  lease_until BIGINT NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  sync_error TEXT NOT NULL DEFAULT '',
  synced_fingerprint TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  encrypted_content TEXT NOT NULL,
  source_task_id TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  source_citations TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_memories_owner ON bot_memories(tenant_id,user_id,status,updated_at);

CREATE TABLE IF NOT EXISTS bot_context_receipts (
  task_id TEXT NOT NULL REFERENCES bot_tasks(id),
  kind TEXT NOT NULL,
  context_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(task_id,kind,context_id)
);
