use std::{env, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub production: bool,
    pub database_url: String,
    pub qdrant_url: String,
    pub qdrant_api_key: String,
    pub qdrant_collection_prefix: String,
    pub allow_insecure_http: bool,
    pub storage_path: PathBuf,
    pub bind_address: String,
    pub public_url: String,
    pub cors_origins: Vec<String>,
    pub seed_demo: bool,
    pub worker_enabled: bool,
    pub agent_enabled: bool,
    pub bot_code_enabled: bool,
    pub bot_code_image: String,
    pub bot_connector_hosts: Vec<String>,
    pub agent_node: String,
    pub agent_script: String,
    pub agent_web_enabled: bool,
    pub agent_context_window: usize,
    pub agent_max_output_tokens: usize,
    pub bot_slice_seconds: u64,
    pub web_search_url: String,
    pub processor_python: String,
    pub processor_script: String,
    pub ai_base_url: String,
    pub ai_api_key: String,
    pub chat_model: String,
    pub vision_model: String,
    pub embedding_model: String,
    pub embedding_dimensions: usize,
    pub vision_base_url: String,
    pub vision_api_key: String,
    pub chat_base_url: String,
    pub chat_api_key: String,
    pub embedding_base_url: String,
    pub embedding_api_key: String,
    pub embedding_index_id: String,
    pub chat_enabled: bool,
    pub embedding_enabled: bool,
    pub vision_enabled: bool,
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_region: String,
    pub oidc_discovery_url: String,
    pub oidc_client_id: String,
    pub oidc_client_secret: String,
    pub oidc_tenant_slug: String,
}
fn get(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_owned())
}
impl Config {
    pub fn load() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        let config = Self {
            production: get("ENVIRONMENT", "development") == "production",
            database_url: get("DATABASE_URL", "sqlite://data/atlas.db?mode=rwc"),
            qdrant_url: get("QDRANT_URL", ""),
            qdrant_api_key: get("QDRANT_API_KEY", ""),
            qdrant_collection_prefix: get("QDRANT_COLLECTION_PREFIX", "atlas"),
            allow_insecure_http: get("ALLOW_INSECURE_HTTP", "false") == "true",
            storage_path: get("STORAGE_PATH", "data/files").into(),
            bind_address: get("BIND_ADDRESS", "127.0.0.1:8000"),
            public_url: get("PUBLIC_URL", "http://localhost:5173"),
            cors_origins: get(
                "CORS_ORIGINS",
                "http://localhost:5173,http://127.0.0.1:5173",
            )
            .split(',')
            .map(str::trim)
            .map(str::to_owned)
            .collect(),
            seed_demo: get("SEED_DEMO", "false") == "true",
            worker_enabled: get("WORKER_ENABLED", "true") == "true",
            agent_enabled: get("PI_AGENT_ENABLED", "true") == "true",
            bot_code_enabled: get("BOT_CODE_ENABLED", "false") == "true",
            bot_code_image: get("BOT_CODE_IMAGE", "python:3.12-alpine"),
            bot_connector_hosts: get("BOT_CONNECTOR_HOSTS", "")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            agent_node: get("PI_AGENT_NODE", "node"),
            agent_script: get("PI_AGENT_SCRIPT", "agent-runtime/agent.mjs"),
            agent_web_enabled: get("AGENT_WEB_ENABLED", "true") == "true",
            agent_context_window: get("AGENT_CONTEXT_WINDOW", "32768").parse()?,
            agent_max_output_tokens: get("AGENT_MAX_OUTPUT_TOKENS", "5000").parse()?,
            bot_slice_seconds: get("BOT_AGENT_SLICE_SECONDS", "600").parse()?,
            web_search_url: get("WEB_SEARCH_URL", ""),
            processor_python: get("PROCESSOR_PYTHON", "processor/.venv/bin/python"),
            processor_script: get("PROCESSOR_SCRIPT", "processor/extract.py"),
            ai_base_url: get("AI_BASE_URL", "https://api.openai.com/v1"),
            ai_api_key: get("AI_API_KEY", ""),
            chat_model: get("CHAT_MODEL", ""),
            vision_model: get("VISION_MODEL", ""),
            embedding_model: get("EMBEDDING_MODEL", ""),
            embedding_dimensions: get("EMBEDDING_DIMENSIONS", "1536").parse()?,
            vision_base_url: get("VISION_BASE_URL", ""),
            vision_api_key: get("VISION_API_KEY", ""),
            chat_base_url: String::new(),
            chat_api_key: String::new(),
            embedding_base_url: String::new(),
            embedding_api_key: String::new(),
            embedding_index_id: String::new(),
            chat_enabled: true,
            embedding_enabled: true,
            vision_enabled: true,
            s3_endpoint: get("S3_ENDPOINT", ""),
            s3_bucket: get("S3_BUCKET", ""),
            s3_access_key: get("S3_ACCESS_KEY", ""),
            s3_secret_key: get("S3_SECRET_KEY", ""),
            s3_region: get("S3_REGION", "us-east-1"),
            oidc_discovery_url: get("OIDC_DISCOVERY_URL", ""),
            oidc_client_id: get("OIDC_CLIENT_ID", ""),
            oidc_client_secret: get("OIDC_CLIENT_SECRET", ""),
            oidc_tenant_slug: get("OIDC_TENANT_SLUG", "atlas"),
        };
        anyhow::ensure!(
            (1..=2000).contains(&config.embedding_dimensions),
            "EMBEDDING_DIMENSIONS must be 1..2000 for pgvector HNSW"
        );
        anyhow::ensure!(
            (8192..=2_000_000).contains(&config.agent_context_window)
                && (512..=32000).contains(&config.agent_max_output_tokens)
                && config.agent_max_output_tokens + 4096 < config.agent_context_window
                && (10..=3600).contains(&config.bot_slice_seconds),
            "Invalid Agent context/output window or bot time slice"
        );
        if config.production {
            anyhow::ensure!(!config.seed_demo, "SEED_DEMO must be false in production");
            anyhow::ensure!(
                config.database_url.starts_with("postgres"),
                "Production requires PostgreSQL"
            );
            anyhow::ensure!(
                config.public_url.starts_with("https://")
                    || config.allow_insecure_http && config.public_url.starts_with("http://"),
                "Production PUBLIC_URL requires HTTPS"
            );
            anyhow::ensure!(
                !config.s3_bucket.is_empty(),
                "Production requires S3 object storage"
            );
            anyhow::ensure!(
                config.cors_origins.iter().all(|s| s.starts_with("https://")
                    || config.allow_insecure_http && s.starts_with("http://")),
                "Production CORS origins require HTTPS"
            );
        }
        Ok(config)
    }
    pub fn embeddings(&self) -> bool {
        self.embedding_enabled
            && (!self.ai_api_key.is_empty() || !self.embedding_base_url.is_empty())
            && !self.embedding_model.is_empty()
    }
    pub fn vision(&self) -> bool {
        self.vision_enabled
            && !(self.vision_api_key.is_empty()
                && self.ai_api_key.is_empty()
                && self.vision_base_url.is_empty())
            && !self.vision_model.is_empty()
    }
    pub fn chat(&self) -> bool {
        self.chat_enabled
            && (!self.ai_api_key.is_empty() || !self.chat_base_url.is_empty())
            && !self.chat_model.is_empty()
    }
    pub fn embedding_identity(&self) -> &str {
        if self.embedding_index_id.is_empty() {
            &self.embedding_model
        } else {
            &self.embedding_index_id
        }
    }
    pub fn oidc(&self) -> bool {
        !self.oidc_discovery_url.is_empty() && !self.oidc_client_id.is_empty()
    }
}
