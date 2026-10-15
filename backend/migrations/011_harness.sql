CREATE TABLE IF NOT EXISTS bot_harness_plugins (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'npm',
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  encrypted_config TEXT NOT NULL DEFAULT '',
  config_rows TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,name)
);
CREATE TABLE IF NOT EXISTS bot_harness_marketplaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(tenant_id,user_id,source)
);
