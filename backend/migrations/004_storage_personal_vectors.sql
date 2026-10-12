CREATE TABLE IF NOT EXISTS storage_profiles (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), payload TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tenant_storage_configs (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), profile_id TEXT REFERENCES storage_profiles(id), revision BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS object_locations (object_key TEXT PRIMARY KEY, backend TEXT NOT NULL, profile_id TEXT REFERENCES storage_profiles(id));
CREATE TABLE IF NOT EXISTS personal_spaces (space_id TEXT PRIMARY KEY REFERENCES spaces(id), user_id TEXT NOT NULL UNIQUE REFERENCES users(id));
CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id), auto_archive BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS studio_archives (asset_id TEXT PRIMARY KEY REFERENCES studio_assets(id), document_id TEXT NOT NULL UNIQUE REFERENCES documents(id));
CREATE TABLE IF NOT EXISTS document_cleanup_jobs (document_id TEXT PRIMARY KEY REFERENCES documents(id), object_keys TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, available_at BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS vector_collections (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS vector_jobs (document_id TEXT PRIMARY KEY REFERENCES documents(id), revision BIGINT NOT NULL DEFAULT 1, synced_revision BIGINT NOT NULL DEFAULT 0, error TEXT, available_at BIGINT NOT NULL DEFAULT 0);
