pub mod acl;
pub mod agent;
pub mod ai;
pub mod api;
pub mod auth;
pub mod bot;
pub mod bot_bridge;
pub mod bot_connection;
pub mod config;
pub mod db;
pub mod documents;
pub mod error;
pub mod indexer;
pub mod inspiration;
pub mod mcp;
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
        .route(
            "/api/bot/connectors",
            get(bot::connectors).post(bot::create_connector),
        )
        .route(
            "/api/bot/connectors/{id}",
            axum::routing::delete(bot::delete_connector),
        )
        .route("/api/bot/connectors/{id}/test", post(bot::test_connector))
        .route("/api/bot/actions/{id}/approve", post(bot::approve))
        .route("/api/bot/actions/{id}/reject", post(bot::reject))
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
        .layer(TraceLayer::new_for_http())
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
