pub mod acl;
pub mod agent;
pub mod ai;
pub mod api;
pub mod auth;
pub mod bot;
pub mod bot_bridge;
pub mod bot_cloud;
pub mod bot_connection;
pub mod bot_feishu;
pub mod bot_knowledge;
pub mod bot_memory;
pub mod bot_skill_review;
pub mod config;
pub mod core_skill_registry;
pub mod db;
pub mod documents;
pub mod error;
pub mod harness;
pub mod indexer;
pub mod inspiration;
pub mod mcp;
pub mod memory_provider;
pub mod models;
pub mod org;
pub mod personal;
pub mod qdrant;
pub mod rag;
pub mod retrieval;
pub mod seed;
pub mod sso;
pub mod storage;
pub mod studio;
pub mod studio_inputs;
pub mod web;
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;
use tower_http::{
    cors::CorsLayer, services::ServeDir, set_header::SetResponseHeaderLayer, trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub config: Arc<config::Config>,
    pub storage: storage::Storage,
    pub http: reqwest::Client,
    pub dummy_password: String,
    pub model_key: Option<Arc<[u8; 32]>>,
    pub model_tenant: Option<String>,
    pub agent_slots: Arc<tokio::sync::Semaphore>,
}
impl AppState {
    pub async fn new(config: config::Config) -> anyhow::Result<Self> {
        tokio::fs::create_dir_all("data").await?;
        let db = db::Db::connect(&config.database_url).await?;
        db.migrate(config.embedding_dimensions, !config.qdrant_url.is_empty())
            .await?;
        let model_key = models::encryption_key(&config).await?;
        let storage = storage::Storage::new(&config, db.clone(), model_key.clone())?;
        Ok(Self {
            db,
            storage,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            dummy_password: auth::password_hash(&auth::token())?,
            model_key,
            model_tenant: None,
            agent_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            config: Arc::new(config),
        })
    }
    pub async fn for_tenant(&self, tenant: &str) -> anyhow::Result<Self> {
        if self.model_tenant.as_deref() == Some(tenant) {
            return Ok(self.clone());
        }
        anyhow::ensure!(
            self.model_tenant.is_none(),
            "A model snapshot cannot be reused across tenants"
        );
        let mut state = self.clone();
        let (settings, revision) = models::load(self, tenant).await?;
        if revision > 0 {
            state.config = Arc::new(settings.apply(&self.config));
        }
        state.model_tenant = Some(tenant.to_owned());
        Ok(state)
    }
}
async fn origin_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // Browser cookie writes require a trusted Origin. Agent calls use bearer tokens.
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if let Some(origin) = origin {
        if !state.config.cors_origins.iter().any(|v| v == origin)
            && state.config.public_url.trim_end_matches('/') != origin
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"不受信任的请求来源"})),
            )
                .into_response();
        }
    }
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && request.headers().contains_key(header::COOKIE)
        && !request.headers().contains_key(header::AUTHORIZATION)
        && origin.is_none()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"使用会话修改数据时必须提供 Origin"})),
        )
            .into_response();
    }
    next.run(request).await
}
pub fn router(state: AppState) -> Router {
    let origins: Vec<HeaderValue> = state
        .config
        .cors_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            axum::http::HeaderName::from_static("mcp-protocol-version"),
        ]);
    Router::new()
        .route("/api/public-config", get(public_config))
        .route("/api/principals", get(org::principals))
        .route("/api/health", get(health))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/oidc/login", get(sso::login))
        .route("/api/auth/oidc/callback", get(sso::callback))
        .route("/api/spaces", get(org::list_spaces).post(org::create_space))
        .route(
            "/api/spaces/{id}/grants",
            get(org::grants).put(org::set_grants),
        )
        .route("/api/organization", get(org::organization))
        .route("/api/departments", post(org::create_department))
        .route("/api/departments/{id}", put(org::update_department))
        .route("/api/users", post(org::create_user))
        .route("/api/users/{id}", put(org::update_user))
        .route(
            "/api/documents",
            get(documents::list).post(documents::create_text),
        )
        .route(
            "/api/documents/upload",
            post(documents::upload).layer(DefaultBodyLimit::max(documents::MAX_UPLOAD_BODY_BYTES)),
        )
        .route(
            "/api/documents/{id}",
            get(documents::get).delete(documents::delete),
        )
        .route("/api/documents/{id}/retry", post(documents::retry))
        .route("/api/documents/{id}/status", get(documents::status))
        .route("/api/documents/{id}/file", get(documents::file))
        .route("/api/documents/{id}/versions", get(documents::versions))
        .route("/api/chunks/{id}/image", get(documents::image))
        .route("/api/search", post(api::search))
        .route("/api/chat", post(api::chat))
        .route("/api/conversations", get(api::conversations))
        .route("/api/conversations/{id}/messages", get(api::messages))
        .route("/api/keys", get(api::keys).post(api::create_key))
        .route("/api/keys/{id}", axum::routing::delete(api::revoke_key))
        .route("/api/audit", get(api::audits))
        .route("/api/jobs", get(api::jobs))
        .route("/api/stats", get(api::stats))
        .route(
            "/api/settings/storage",
            get(storage::settings).put(storage::save),
        )
        .route("/api/settings/storage/test", post(storage::test))
        .route(
            "/api/personal/preferences",
            get(personal::get).put(personal::save),
        )
        .route("/api/models", get(models::get).put(models::save))
        .route("/api/models/test", post(models::test))
        .route("/api/models/discover", post(models::discover))
        .route("/api/studio/capabilities", get(studio::capabilities))
        .route(
            "/api/studio/projects",
            get(studio::projects).post(studio::create_project),
        )
        .route("/api/studio/projects/{id}", get(studio::get_project))
        .route("/api/studio/chat", post(studio::chat))
        .route("/api/studio/assets/{id}", get(studio::asset))
        .route(
            "/api/studio/attachments",
            post(studio_inputs::upload)
                .layer(DefaultBodyLimit::max(studio_inputs::MAX_BYTES + 1_048_576)),
        )
        .route(
            "/api/studio/attachments/{id}",
            get(studio_inputs::read).delete(studio_inputs::remove),
        )
        .route(
            "/api/studio/assets/{id}/reference",
            post(studio_inputs::reference),
        )
        .route("/api/bot/harness", get(harness::status))
        .route("/api/bot/harness/update", post(harness::update))
        .route("/api/bot/cloud", get(bot_cloud::status))
        .route("/api/bot/cloud/connect", post(bot_cloud::connect))
        .route("/api/bot/cloud/heartbeat", post(bot_cloud::heartbeat))
        .route("/api/bot/cloud/disconnect", post(bot_cloud::disconnect))
        .route("/api/bot/cloud/files", get(bot_cloud::files))
        .route("/api/bot/plugins/catalog", get(harness::catalog))
        .route("/api/bot/plugins/install", post(harness::install))
        .route(
            "/api/bot/plugins/{id}",
            axum::routing::delete(harness::remove),
        )
        .route("/api/bot/plugins/{id}/enable", post(harness::enable))
        .route(
            "/api/bot/plugins/{id}/config",
            get(harness::configuration).post(harness::configure),
        )
        .route("/api/bot/plugins/marketplaces", post(harness::add_market))
        .route(
            "/api/bot/plugins/marketplaces/{id}",
            axum::routing::delete(harness::remove_market),
        )
        .route("/api/bot/devices", get(bot_bridge::devices))
        .route(
            "/api/bot/devices/{id}",
            axum::routing::delete(bot_bridge::revoke),
        )
        .route("/api/bot/pairings", post(bot_bridge::pairing))
        .route("/api/bot/local/connections", post(bot_connection::begin))
        .route(
            "/api/bot/local/connections/poll",
            post(bot_connection::poll),
        )
        .route(
            "/api/bot/local/connections/cancel",
            post(bot_connection::cancel),
        )
        .route("/api/bot/connections/{id}", get(bot_connection::details))
        .route(
            "/api/bot/connections/{id}/approve",
            post(bot_connection::approve),
        )
        .route("/api/bot/local/pair", post(bot_bridge::pair))
        .route("/api/bot/local/disconnect", post(bot_bridge::disconnect))
        .route("/api/bot/local/poll", post(bot_bridge::poll))
        .route("/api/bot/local/import", post(bot_bridge::import))
        .route("/api/bot/local/tasks/{id}/start", post(bot_bridge::start))
        .route("/api/bot/local/tasks/{id}/sync", post(bot_bridge::sync))
        .route(
            "/api/bot/local/tasks/{id}/cancel-ack",
            post(bot_bridge::cancel_ack),
        )
        .route("/api/bot/local/tasks/{id}/tool", post(bot_bridge::tool))
        .route("/api/bot/capabilities", get(bot::capabilities))
        .route("/api/bot/game/inspiration/runs", post(inspiration::start))
        .route(
            "/api/bot/game/inspiration/runs/{id}/finish",
            post(inspiration::finish),
        )
        .route(
            "/api/bot/game/inspiration/leaderboard",
            get(inspiration::leaderboard),
        )
        .route("/api/bot/tasks", get(bot::tasks).post(bot::create_task))
        .route("/api/bot/tasks/{id}", get(bot::get_task))
        .route("/api/bot/tasks/{id}/stream", get(bot::stream_task))
        .route("/api/bot/tasks/{id}/cancel", post(bot::cancel))
        .route("/api/bot/tasks/{id}/retry", post(bot::retry))
        .route("/api/bot/artifacts/{id}", get(bot::artifact))
        .route("/api/bot/artifacts/{id}/preview", get(bot_cloud::preview))
        .route("/api/bot/artifacts/{id}/render", get(bot_cloud::render))
        .route(
            "/api/bot/connectors",
            get(bot::connectors).post(bot::create_connector),
        )
        .route(
            "/api/bot/connectors/{id}",
            axum::routing::delete(bot::delete_connector),
        )
        .route("/api/bot/connectors/{id}/test", post(bot::test_connector))
        .route("/api/bot/connectors/feishu/status", get(bot_feishu::status))
        .route("/api/bot/connectors/feishu/authorize", post(bot_feishu::authorize))
        .route("/api/bot/connectors/feishu/callback", get(bot_feishu::callback).layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        )))
        .route("/api/bot/connectors/feishu/tools", get(bot_feishu::tools))
        .route("/api/bot/actions/{id}/approve", post(bot::approve))
        .route("/api/bot/actions/{id}/reject", post(bot::reject))
        .route(
            "/api/bot/memories",
            get(bot_memory::list).post(bot_memory::create),
        )
        .route(
            "/api/bot/memories/{id}",
            axum::routing::put(bot_memory::update).delete(bot_memory::remove),
        )
        .route("/api/bot/memories/{id}/review", post(bot_memory::review))
        .route("/api/bot/memories/forget", post(bot_memory::forget))
        .route(
            "/api/bot/memory/settings",
            get(bot_memory::get_settings).put(bot_memory::save_settings),
        )
        .route("/api/bot/memory/providers", get(memory_provider::status))
        .route(
            "/api/bot/skill-candidates",
            get(bot_skill_review::list).post(bot_skill_review::create),
        )
        .route(
            "/api/bot/skill-candidates/{id}",
            axum::routing::put(bot_skill_review::update).delete(bot_skill_review::remove),
        )
        .route(
            "/api/bot/skill-candidates/{id}/review",
            post(bot_skill_review::review),
        )
        .route(
            "/api/bot/knowledge/assets",
            get(bot_knowledge::list).post(bot_knowledge::create),
        )
        .route(
            "/api/bot/knowledge/assets/{id}",
            get(bot_knowledge::get).delete(bot_knowledge::delete),
        )
        .route(
            "/api/bot/knowledge/assets/{id}/sync",
            post(bot_knowledge::sync),
        )
        .route(
            "/api/bot/knowledge/assets/{id}/search",
            post(bot_knowledge::search),
        )
        .route(
            "/api/bot/knowledge/assets/{id}/tools",
            post(bot_knowledge::tools),
        )
        .route("/api/bot/skills", get(bot::skills).post(bot::create_skill))
        .route(
            "/api/bot/skills/{id}",
            axum::routing::delete(bot::delete_skill),
        )
        .route(
            "/api/openapi.json",
            get(|| async {
                Json(
                    serde_json::from_str::<serde_json::Value>(include_str!(
                        "../../docs/openapi.json"
                    ))
                    .unwrap(),
                )
            }),
        )
        .route("/mcp", post(mcp::handle))
        .route_service(
            "/app",
            tower_http::services::ServeFile::new("frontend/dist/index.html"),
        )
        .route_service(
            "/login",
            tower_http::services::ServeFile::new("frontend/dist/index.html"),
        )
        .fallback_service(ServeDir::new("frontend/dist").not_found_service(
            tower_http::services::ServeFile::new("frontend/dist/index.html"),
        ))
        .layer(DefaultBodyLimit::max(42 * 1024 * 1024))
        .layer(cors)
        .layer(middleware::from_fn_with_state(state.clone(), origin_guard))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(TraceLayer::new_for_http().make_span_with(|request: &Request| {
            // OAuth codes/state and other sensitive query values never enter spans.
            tracing::info_span!("http_request", method = %request.method(), path = %request.uri().path())
        }))
        .with_state(state)
}
async fn health(State(state): State<AppState>) -> Response {
    match state.db.one("SELECT CAST(1 AS BIGINT) AS ok", vec![]).await {
        Ok(_) => Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")})).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unavailable"})),
        )
            .into_response(),
    }
}

async fn public_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({"demo":state.config.seed_demo,"sso":state.config.oidc()}))
}
