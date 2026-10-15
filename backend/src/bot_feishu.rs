//! Feishu public-client OAuth and a deliberately narrow, read-only MCP adapter.
//! Credentials never enter connector metadata, model context, audit, or errors.
use crate::{
    auth::{self, Actor},
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    models, AppState,
};
use axum::{
    extract::{Query, State},
    http::header,
    response::{IntoResponse, Redirect, Response},
    Json,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

const RESOURCE: &str = "https://mcp.feishu.cn/mcp";
const AUTHORIZATION: &str = "https://accounts.feishu.cn/oauth/v2/mcp/authorize";
const TOKEN: &str = "https://accounts.feishu.cn/oauth/v3/token";
const REGISTRATION: &str = "https://open.feishu.cn/open-apis/app/v1/dcr";
const CALLBACK: &str = "/api/bot/connectors/feishu/callback";
const COOKIE: &str = "atlas_feishu_state";
const SCOPES: &str = "offline_access mcp-tool:common:get-user mcp-tool:docs:search-doc mcp-tool:docs:fetch-doc mcp-tool:docs:list-docs-v2";
const MAX_RESPONSE: usize = 256_000;
const READ_TOOLS: &[&str] = &[
    "get-user",
    "search-doc",
    "fetch-doc",
    "list-docs-v2",
    "list-docs",
];

#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    scope: String,
}
struct Grant {
    tokens: Tokens,
    access_expires_at: i64,
    refresh_expires_at: i64,
}
struct McpSession {
    id: Option<String>,
    protocol: String,
}
// Endpoints are not user/deployment-configurable. Test overrides exist only in unit tests.
struct Provider {
    client: reqwest::Client,
    registration: String,
    token: String,
    resource: String,
}
#[derive(Clone, Copy, Debug)]
enum ProviderFailure {
    Authorization,
    Unavailable,
    Invalid,
    Oversized,
}
impl ProviderFailure {
    fn error(self) -> AppError {
        AppError::bad(match self {
            Self::Authorization => "飞书授权已失效或缺少读取权限，请重新连接飞书",
            Self::Unavailable => "暂时无法连接飞书，请稍后重试",
            Self::Invalid => "飞书返回的授权或工具格式不受支持，请重新连接或稍后重试",
            Self::Oversized => "飞书响应超过 256 KB，请缩小查询范围",
        })
    }
}
type ProviderResult<T> = std::result::Result<T, ProviderFailure>;
impl Provider {
    fn official() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| AppError::bad("无法初始化飞书连接"))?,
            registration: REGISTRATION.into(),
            token: TOKEN.into(),
            resource: RESOURCE.into(),
        })
    }
    async fn read(
        &self,
        response: reqwest::Response,
        expected_id: Option<&str>,
    ) -> ProviderResult<(Value, Option<String>)> {
        if matches!(response.status().as_u16(), 400 | 401 | 403) {
            return Err(ProviderFailure::Authorization);
        }
        if !response.status().is_success() {
            return Err(ProviderFailure::Unavailable);
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .map(|v| {
                v.to_str()
                    .map(str::to_owned)
                    .map_err(|_| ProviderFailure::Invalid)
            })
            .transpose()?;
        if session
            .as_ref()
            .is_some_and(|v| v.len() > 512 || !v.bytes().all(|b| (33..=126).contains(&b)))
        {
            return Err(ProviderFailure::Invalid);
        }
        let is_sse = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.starts_with("text/event-stream"));
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ProviderFailure::Unavailable)?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(ProviderFailure::Oversized);
            }
            bytes.extend_from_slice(&chunk);
            if is_sse {
                // Streamable HTTP may keep the stream open after its response.
                // Return on a complete response event rather than waiting for EOF.
                if let Some(value) = sse_response(&bytes, false, expected_id)? {
                    return Ok((value, session));
                }
            }
        }
        if bytes.is_empty() {
            return Ok((Value::Null, session));
        }
        let value = if is_sse {
            sse_response(&bytes, true, expected_id)?.ok_or(ProviderFailure::Invalid)?
        } else {
            serde_json::from_slice(&bytes).map_err(|_| ProviderFailure::Invalid)?
        };
        Ok((value, session))
    }
    async fn register(&self, redirect: &str) -> ProviderResult<String> {
        let response = self
            .client
            .post(&self.registration)
            .json(&json!({
                "client_name":"知小汇", "redirect_uris":[redirect],
                "grant_types":["authorization_code","refresh_token"], "response_types":["code"],
                "token_endpoint_auth_method":"none"
            }))
            .send()
            .await
            .map_err(|_| ProviderFailure::Unavailable)?;
        let (payload, _) = self.read(response, None).await?;
        let payload = oauth_payload(&payload)?;
        let client = payload["client_id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 1024)
            .ok_or(ProviderFailure::Invalid)?;
        if payload
            .get("token_endpoint_auth_method")
            .is_some_and(|v| v != "none")
            || payload
                .get("client_secret")
                .is_some_and(|v| v.as_str().is_none_or(|s| !s.is_empty()))
            || payload
                .get("redirect_uris")
                .is_some_and(|v| v != &json!([redirect]))
        {
            return Err(ProviderFailure::Invalid);
        }
        Ok(client.to_owned())
    }
    async fn grant(&self, fields: &[(&str, &str)], old: Option<&Tokens>) -> ProviderResult<Grant> {
        let response = self
            .client
            .post(&self.token)
            .form(fields)
            .send()
            .await
            .map_err(|_| ProviderFailure::Unavailable)?;
        let (payload, _) = self.read(response, None).await?;
        let payload = oauth_payload(&payload)?;
        if payload.get("error").is_some() {
            return Err(ProviderFailure::Authorization);
        }
        let access = token_field(payload, "access_token")?;
        let refresh = token_field(payload, "refresh_token")?;
        if payload
            .get("token_type")
            .is_some_and(|v| !v.as_str().is_some_and(|s| s.eq_ignore_ascii_case("bearer")))
        {
            return Err(ProviderFailure::Invalid);
        }
        let lifetime = payload["expires_in"]
            .as_i64()
            .filter(|v| (1..=604800).contains(v))
            .ok_or(ProviderFailure::Invalid)?;
        let refresh_lifetime = payload["refresh_token_expires_in"]
            .as_i64()
            .filter(|v| (1..=31_622_400).contains(v))
            .ok_or(ProviderFailure::Invalid)?;
        let scope = payload["scope"]
            .as_str()
            .unwrap_or_else(|| old.map(|v| v.scope.as_str()).unwrap_or(SCOPES));
        if scope.len() > 4096 {
            return Err(ProviderFailure::Invalid);
        }
        Ok(Grant {
            tokens: Tokens {
                access_token: access,
                refresh_token: refresh,
                scope: scope.into(),
            },
            access_expires_at: now() + lifetime * 1000,
            refresh_expires_at: now() + refresh_lifetime * 1000,
        })
    }
    async fn rpc(
        &self,
        access: &str,
        session: Option<&McpSession>,
        method: &str,
        params: Value,
        key: Option<&str>,
    ) -> ProviderResult<(Value, Option<String>)> {
        let mut body = json!({"jsonrpc":"2.0", "method":method, "params":params});
        if let Some(key) = key {
            body["id"] = json!(key);
        }
        let mut request = self
            .client
            .post(&self.resource)
            .bearer_auth(access)
            .header("accept", "application/json, text/event-stream")
            .header(
                "MCP-Protocol-Version",
                session.map(|v| v.protocol.as_str()).unwrap_or("2025-06-18"),
            )
            .json(&body);
        if let Some(session) = session.and_then(|v| v.id.as_deref()) {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = request
            .send()
            .await
            .map_err(|_| ProviderFailure::Unavailable)?;
        let (payload, returned_session) = self.read(response, key).await?;
        if let Some(key) = key {
            if payload["jsonrpc"] != "2.0" || payload["id"] != key {
                return Err(ProviderFailure::Invalid);
            }
            if payload.get("error").is_some() {
                return Err(ProviderFailure::Invalid);
            }
            if !payload["result"].is_object() {
                return Err(ProviderFailure::Invalid);
            }
            Ok((payload["result"].clone(), returned_session))
        } else {
            Ok((Value::Null, returned_session))
        }
    }
    async fn catalog(&self, access: &str, scope: &str) -> ProviderResult<(Vec<Value>, McpSession)> {
        let (initialize, session_id) = self
            .rpc(
                access,
                None,
                "initialize",
                json!({
                    "protocolVersion":"2025-06-18", "capabilities":{},
                    "clientInfo":{"name":"zhixiaohui","version":"1.0.0"}
                }),
                Some("initialize"),
            )
            .await?;
        let protocol = initialize["protocolVersion"]
            .as_str()
            .filter(|v| ["2024-11-05", "2025-03-26", "2025-06-18"].contains(v))
            .ok_or(ProviderFailure::Invalid)?;
        if !initialize["capabilities"]["tools"].is_object() {
            return Err(ProviderFailure::Invalid);
        }
        let session = McpSession {
            id: session_id,
            protocol: protocol.into(),
        };
        self.rpc(
            access,
            Some(&session),
            "notifications/initialized",
            json!({}),
            None,
        )
        .await?;
        let mut catalog = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..10 {
            let params = cursor
                .as_ref()
                .map(|v| json!({"cursor":v}))
                .unwrap_or(json!({}));
            let (page, _) = self
                .rpc(access, Some(&session), "tools/list", params, Some("tools"))
                .await?;
            let tools = page["tools"]
                .as_array()
                .filter(|v| v.len() <= 250)
                .ok_or(ProviderFailure::Invalid)?;
            for tool in tools {
                if let Some(safe) = safe_tool(tool)? {
                    let name = safe["name"].as_str().unwrap().to_owned();
                    if !scope_allows(scope, &name) {
                        continue;
                    }
                    if !seen.insert(name) {
                        return Err(ProviderFailure::Invalid);
                    }
                    catalog.push(safe);
                }
            }
            if serde_json::to_vec(&catalog)
                .map_err(|_| ProviderFailure::Invalid)?
                .len()
                > MAX_RESPONSE
            {
                return Err(ProviderFailure::Oversized);
            }
            cursor = page["nextCursor"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok((catalog, session));
            }
            if cursor.as_ref().is_some_and(|v| v.len() > 4096) {
                return Err(ProviderFailure::Invalid);
            }
        }
        Err(ProviderFailure::Oversized)
    }
}
fn sse_response(
    bytes: &[u8],
    eof: bool,
    expected_id: Option<&str>,
) -> ProviderResult<Option<Value>> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) if !eof && error.error_len().is_none() => return Ok(None),
        Err(_) => return Err(ProviderFailure::Invalid),
    };
    let text = text.replace("\r\n", "\n");
    let mut events = text.split("\n\n").collect::<Vec<_>>();
    if !eof {
        events.pop();
    }
    for event in events {
        let data = event
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .map(|v| v.strip_prefix(' ').unwrap_or(v))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(&data).map_err(|_| ProviderFailure::Invalid)?;
        if expected_id.is_some_and(|key| message["id"] == key) {
            return Ok(Some(message));
        }
    }
    Ok(None)
}
fn token_field(payload: &Value, field: &str) -> ProviderResult<String> {
    payload[field]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 16384 && !v.contains(['\r', '\n']))
        .map(str::to_owned)
        .ok_or(ProviderFailure::Invalid)
}
fn oauth_payload(payload: &Value) -> ProviderResult<&Value> {
    if payload.get("code").is_some_and(|v| v.as_i64() != Some(0)) {
        return Err(ProviderFailure::Authorization);
    }
    Ok(if payload["data"].is_object() {
        &payload["data"]
    } else {
        payload
    })
}
fn safe_tool(tool: &Value) -> ProviderResult<Option<Value>> {
    let Some(name) = tool["name"].as_str() else {
        return Err(ProviderFailure::Invalid);
    };
    if !READ_TOOLS.contains(&name) {
        return Ok(None);
    }
    if !tool["inputSchema"].is_object()
        || tool["inputSchema"]["type"] != "object"
        || tool["description"]
            .as_str()
            .is_some_and(|v| v.len() > 16000)
    {
        return Err(ProviderFailure::Invalid);
    }
    Ok(Some(
        json!({"name":name,"description":tool["description"].as_str().unwrap_or(""),
        "inputSchema":tool["inputSchema"],"annotations":tool["annotations"]}),
    ))
}
fn scope_allows(scope: &str, name: &str) -> bool {
    let required = match name {
        "get-user" => "mcp-tool:common:get-user",
        "search-doc" => "mcp-tool:docs:search-doc",
        "fetch-doc" => "mcp-tool:docs:fetch-doc",
        "list-docs" | "list-docs-v2" => "mcp-tool:docs:list-docs-v2",
        _ => return false,
    };
    scope.split_ascii_whitespace().any(|v| v == required)
}
fn practical_catalog(catalog: &[Value]) -> bool {
    ["search-doc", "fetch-doc"]
        .iter()
        .all(|name| catalog.iter().any(|v| v["name"] == *name))
}
fn redirect_uri(state: &AppState) -> Result<String> {
    let mut url = reqwest::Url::parse(&state.config.public_url)
        .map_err(|_| AppError::bad("应用访问地址配置无效"))?;
    if !["https", "http"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/"].contains(&url.path())
        || (url.scheme() == "http" && state.config.production && !state.config.allow_insecure_http)
    {
        return Err(AppError::bad("飞书连接需要固定且可由浏览器访问的应用地址"));
    }
    url.set_path(CALLBACK);
    Ok(url.to_string())
}
async fn session_binding(state: &AppState, actor: &Actor, jar: &CookieJar) -> Result<String> {
    actor.browser()?;
    let raw = jar
        .get("atlas_session")
        .ok_or_else(AppError::unauthorized)?
        .value();
    let binding = auth::hash(raw);
    if state.db.one("SELECT ss.id FROM sessions ss JOIN users u ON u.id=ss.user_id WHERE ss.id=? AND ss.expires_at>? AND u.id=? AND u.tenant_id=? AND u.active=1",
        vec![json!(binding),json!(now()),json!(actor.id),json!(actor.tenant_id)]).await?.is_none() {
        return Err(AppError::unauthorized());
    }
    Ok(binding)
}
async fn registered_client(
    state: &AppState,
    actor: &Actor,
    provider: &Provider,
    redirect: &str,
) -> Result<String> {
    state.db.exec("INSERT INTO bot_feishu_clients(tenant_id,updated_at) VALUES(?,?) ON CONFLICT(tenant_id) DO NOTHING", vec![json!(actor.tenant_id),json!(now())]).await?;
    for _ in 0..100 {
        let row = state
            .db
            .one(
                "SELECT * FROM bot_feishu_clients WHERE tenant_id=?",
                vec![json!(actor.tenant_id)],
            )
            .await?
            .ok_or_else(AppError::missing)?;
        if s(&row, "redirect_uri") == redirect && !s(&row, "client_id").is_empty() {
            return Ok(s(&row, "client_id").into());
        }
        let lease = id();
        let claimed = state.db.exec("UPDATE bot_feishu_clients SET registration_lease=?,lease_until=? WHERE tenant_id=? AND lease_until<? AND revision=?",vec![json!(lease),json!(now()+60_000),json!(actor.tenant_id),json!(now()),json!(n(&row,"revision"))]).await?;
        if claimed == 0 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let result = provider.register(redirect).await;
        match result {
            Ok(client) => {
                let changed = state.db.exec("UPDATE bot_feishu_clients SET client_id=?,redirect_uri=?,registration_lease='',lease_until=0,revision=revision+1,updated_at=? WHERE tenant_id=? AND registration_lease=?",vec![json!(client),json!(redirect),json!(now()),json!(actor.tenant_id),json!(lease)]).await?;
                if changed != 1 {
                    return Err(AppError::bad("飞书连接初始化已变化，请重试"));
                }
                return Ok(client);
            }
            Err(error) => {
                state.db.exec("UPDATE bot_feishu_clients SET registration_lease='',lease_until=0 WHERE tenant_id=? AND registration_lease=?",vec![json!(actor.tenant_id),json!(lease)]).await?;
                return Err(AppError::bad(match error {
                    ProviderFailure::Authorization | ProviderFailure::Invalid => {
                        "飞书暂未接受当前连接配置，请稍后重试或联系管理员"
                    }
                    _ => "暂时无法初始化飞书连接，请稍后重试",
                }));
            }
        }
    }
    Err(AppError::bad("飞书连接正在初始化，请稍后重试"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authorize {}
pub async fn authorize(
    State(state): State<AppState>,
    actor: Actor,
    jar: CookieJar,
    Json(_): Json<Authorize>,
) -> Result<Response> {
    let result = authorize_with(&state, &actor, jar, &Provider::official()?).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], result).into_response())
}
async fn authorize_with(
    state: &AppState,
    actor: &Actor,
    jar: CookieJar,
    provider: &Provider,
) -> Result<(CookieJar, Json<Value>)> {
    let binding = session_binding(state, actor, &jar).await?;
    if state.model_key.is_none() {
        return Err(AppError::bad("服务器尚未启用凭据加密，无法连接飞书"));
    }
    let redirect = redirect_uri(state)?;
    let client = registered_client(state, actor, provider, &redirect).await?;
    let secret = auth::token();
    let browser = auth::token();
    let verifier = auth::token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    state
        .db
        .exec(
            "DELETE FROM bot_feishu_oauth_states WHERE expires_at<?",
            vec![json!(now())],
        )
        .await?;
    state.db.exec("INSERT INTO bot_feishu_oauth_states(id,tenant_id,user_id,session_hash,browser_hash,encrypted_verifier,client_id,redirect_uri,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(auth::hash(&secret)),json!(actor.tenant_id),json!(actor.id),json!(binding),json!(auth::hash(&browser)),json!(models::seal(state,&actor.tenant_id,&verifier)?),json!(client),json!(redirect),json!(now()+600_000)]).await?;
    let mut url =
        reqwest::Url::parse(AUTHORIZATION).map_err(|_| AppError::bad("飞书授权地址无效"))?;
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &client),
        ("redirect_uri", &redirect),
        ("scope", SCOPES),
        ("state", &secret),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("resource", RESOURCE),
    ]);
    let cookie = Cookie::build((COOKIE, browser))
        .path(CALLBACK)
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.production && !state.config.allow_insecure_http)
        .max_age(time::Duration::minutes(10))
        .build();
    Ok((
        jar.add(cookie),
        Json(json!({"authorization_url":url.to_string()})),
    ))
}

#[derive(Deserialize)]
pub struct Callback {
    #[serde(default)]
    state: String,
    code: Option<String>,
    error: Option<String>,
}
pub async fn callback(
    State(state): State<AppState>,
    actor: Actor,
    jar: CookieJar,
    Query(input): Query<Callback>,
) -> Result<Response> {
    let result =
        match callback_with(&state, &actor, jar.clone(), input, &Provider::official()?).await {
            Ok(result) => result,
            Err(_) => (
                jar.remove(Cookie::build(COOKIE).path(CALLBACK).build()),
                Redirect::to("/app?view=bot&feishu=error"),
            ),
        };
    let mut response = (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        result,
    )
        .into_response();
    *response.status_mut() = axum::http::StatusCode::FOUND;
    Ok(response)
}
async fn callback_with(
    state: &AppState,
    actor: &Actor,
    jar: CookieJar,
    input: Callback,
    provider: &Provider,
) -> Result<(CookieJar, Redirect)> {
    let binding = session_binding(state, actor, &jar).await?;
    if input.state.len() != 64 || !input.state.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::forbidden());
    }
    let browser = jar.get(COOKIE).ok_or_else(AppError::forbidden)?.value();
    let entry = state.db.one("DELETE FROM bot_feishu_oauth_states WHERE id=? AND tenant_id=? AND user_id=? AND session_hash=? AND browser_hash=? AND expires_at>? RETURNING client_id,redirect_uri,encrypted_verifier,session_hash",vec![json!(auth::hash(&input.state)),json!(actor.tenant_id),json!(actor.id),json!(binding),json!(auth::hash(browser)),json!(now())]).await?.ok_or_else(AppError::forbidden)?;
    let jar = jar.remove(Cookie::build(COOKIE).path(CALLBACK).build());
    let outcome = if input.error.as_deref() == Some("access_denied") {
        "cancelled"
    } else if input.error.is_some() {
        "error"
    } else {
        match connect_grant(state, actor, &entry, input.code.as_deref(), provider).await {
            Ok(_) => "connected",
            Err(_) => "error", // No provider body, code, verifier, or token enters redirect/logs.
        }
    };
    Ok((
        jar,
        Redirect::to(&format!("/app?view=bot&feishu={outcome}")),
    ))
}
async fn connect_grant(
    state: &AppState,
    actor: &Actor,
    entry: &Record,
    code: Option<&str>,
    provider: &Provider,
) -> Result<()> {
    let code = code
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or_else(|| AppError::bad("飞书未返回授权码"))?;
    let redirect = redirect_uri(state)?;
    if redirect != s(entry, "redirect_uri") {
        return Err(AppError::bad("应用地址已变化，请重新连接飞书"));
    }
    let current = state
        .db
        .one(
            "SELECT client_id,redirect_uri FROM bot_feishu_clients WHERE tenant_id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    if s(&current, "client_id") != s(entry, "client_id") || s(&current, "redirect_uri") != redirect
    {
        return Err(AppError::bad("飞书连接初始化已变化，请重试"));
    }
    let verifier: String = models::open(state, &actor.tenant_id, s(entry, "encrypted_verifier"))?;
    let grant = provider
        .grant(
            &[
                ("grant_type", "authorization_code"),
                ("client_id", s(entry, "client_id")),
                ("code", code),
                ("redirect_uri", &redirect),
                ("code_verifier", &verifier),
                ("resource", RESOURCE),
            ],
            None,
        )
        .await
        .map_err(ProviderFailure::error)?;
    let (catalog, _) = provider
        .catalog(&grant.tokens.access_token, &grant.tokens.scope)
        .await
        .map_err(ProviderFailure::error)?;
    if !practical_catalog(&catalog) {
        return Err(AppError::bad("飞书未提供文档搜索与读取权限，请重新连接"));
    }
    let encrypted = models::seal(state, &actor.tenant_id, &grant.tokens)?;
    let config = json!({"provider":"feishu","url":RESOURCE,"method":"GET","token":""});
    let encrypted_config = models::seal(state, &actor.tenant_id, &config)?;
    let mut tx = state.db.pool.begin().await?;
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE sessions SET expires_at=expires_at WHERE id=? AND user_id=? AND expires_at>?",
            vec![entry["session_hash"].clone(), json!(actor.id), json!(now())],
        )
        .await?
        != 1
    {
        return Err(AppError::unauthorized());
    }
    // A real user row lock serializes first connection/reconnection across API processes.
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE users SET active=active WHERE id=? AND tenant_id=? AND active=1",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        != 1
    {
        return Err(AppError::forbidden());
    }
    let existing = state
        .db
        .tx_one(
            &mut tx,
            "SELECT connector_id FROM bot_feishu_accounts WHERE tenant_id=? AND user_id=?",
            vec![json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    let key = existing
        .as_ref()
        .map(|row| s(row, "connector_id").to_owned())
        .unwrap_or_else(id);
    if existing.is_none() {
        state.db.tx_exec(&mut tx,"INSERT INTO bot_connectors(id,tenant_id,user_id,name,description,encrypted_config,created_at) VALUES(?,?,?,'飞书','搜索和读取已授权的飞书云文档与知识库文档',?,?)",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(encrypted_config),json!(now())]).await?;
    } else {
        state.db.tx_exec(&mut tx,"UPDATE bot_connectors SET enabled=1,encrypted_config=? WHERE id=? AND tenant_id=? AND user_id=?",vec![json!(encrypted_config),json!(key),json!(actor.tenant_id),json!(actor.id)]).await?;
    }
    state.db.tx_exec(&mut tx,"INSERT INTO bot_feishu_accounts(connector_id,tenant_id,user_id,client_id,redirect_uri,encrypted_tokens,access_expires_at,refresh_expires_at,tool_catalog,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET client_id=excluded.client_id,redirect_uri=excluded.redirect_uri,encrypted_tokens=excluded.encrypted_tokens,access_expires_at=excluded.access_expires_at,refresh_expires_at=excluded.refresh_expires_at,tool_catalog=excluded.tool_catalog,enabled=1,needs_reconnect=0,version=bot_feishu_accounts.version+1,refresh_lease='',refresh_lease_until=0,updated_at=excluded.updated_at",vec![json!(key),json!(actor.tenant_id),json!(actor.id),entry["client_id"].clone(),json!(redirect),json!(encrypted),json!(grant.access_expires_at),json!(grant.refresh_expires_at),json!(serde_json::to_string(&catalog).map_err(|_| ProviderFailure::Invalid.error())?),json!(now()),json!(now())]).await?;
    state.db.tx_exec(&mut tx,"INSERT INTO audit_events(id,tenant_id,user_id,action,resource_id,details,created_at) VALUES(?,?,?,'bot.feishu.connect',?,'{}',?)",vec![json!(id()),json!(actor.tenant_id),json!(actor.id),json!(key),json!(now())]).await?;
    tx.commit().await?;
    Ok(())
}

async fn account(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    state.db.one("SELECT a.* FROM bot_feishu_accounts a JOIN bot_connectors c ON c.id=a.connector_id WHERE a.connector_id=? AND a.tenant_id=? AND a.user_id=? AND a.enabled=1 AND c.enabled=1 AND c.tenant_id=a.tenant_id AND c.user_id=a.user_id",
        vec![json!(key),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)
}
fn reconnect(state: &AppState, row: &Record) -> bool {
    n(row, "needs_reconnect") != 0
        || s(row, "encrypted_tokens").is_empty()
        || (n(row, "access_expires_at") <= now() + 60_000 && n(row, "refresh_expires_at") <= now())
        || redirect_uri(state).map_or(true, |v| v != s(row, "redirect_uri"))
}
pub async fn status(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let row = state.db.one("SELECT a.* FROM bot_feishu_accounts a JOIN bot_connectors c ON c.id=a.connector_id WHERE a.tenant_id=? AND a.user_id=? AND a.enabled=1 AND c.enabled=1",vec![json!(actor.tenant_id),json!(actor.id)]).await?;
    let available = state.model_key.is_some() && redirect_uri(&state).is_ok();
    let needs = row.as_ref().is_some_and(|v| reconnect(&state, v));
    let mut result =
        json!({"available":available,"connected":row.is_some() && !needs,"needs_reconnect":needs});
    if let Some(row) = row {
        result["connector_id"] = row["connector_id"].clone();
    }
    if !available {
        result["message"] = json!("服务器的应用访问地址或凭据加密尚未配置完成");
    } else if needs {
        result["message"] = json!("飞书授权已失效，请重新连接");
    }
    Ok(Json(result))
}
pub(crate) async fn metadata(state: &AppState, actor: &Actor, key: &str) -> Result<Value> {
    let row = account(state, actor, key).await?;
    Ok(
        json!({"provider":"feishu","status":if reconnect(state,&row){"reconnect_required"}else{"connected"},
        "has_token":!s(&row,"encrypted_tokens").is_empty(),"url":RESOURCE,"method":"GET"}),
    )
}
pub(crate) async fn context_catalog(state: &AppState, actor: &Actor, key: &str) -> Result<Value> {
    let row = account(state, actor, key).await?;
    if reconnect(state, &row) {
        return Err(ProviderFailure::Authorization.error());
    }
    let catalog: Vec<Value> = serde_json::from_str(s(&row, "tool_catalog"))
        .map_err(|_| ProviderFailure::Invalid.error())?;
    let tokens: Tokens = models::open(state, &actor.tenant_id, s(&row, "encrypted_tokens"))?;
    let safe = catalog
        .iter()
        .map(safe_tool)
        .collect::<ProviderResult<Vec<_>>>()
        .map_err(ProviderFailure::error)?;
    Ok(json!(safe
        .into_iter()
        .flatten()
        .filter(|v| scope_allows(&tokens.scope, v["name"].as_str().unwrap_or("")))
        .collect::<Vec<_>>()))
}
pub(crate) async fn disconnect(state: &AppState, actor: &Actor, key: &str) -> Result<()> {
    let mut tx = state.db.pool.begin().await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_feishu_accounts SET enabled=0,encrypted_tokens='',access_expires_at=0,refresh_expires_at=0,tool_catalog='[]',version=version+1,refresh_lease='',refresh_lease_until=0,updated_at=? WHERE connector_id=? AND tenant_id=? AND user_id=?",vec![json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id)]).await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_connectors SET enabled=0 WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    tx.commit().await?;
    Ok(())
}
async fn mark_reconnect(state: &AppState, actor: &Actor, key: &str, version: i64) -> Result<()> {
    state.db.exec("UPDATE bot_feishu_accounts SET needs_reconnect=1,refresh_lease='',refresh_lease_until=0,updated_at=? WHERE connector_id=? AND tenant_id=? AND user_id=? AND enabled=1 AND version=?",vec![json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id),json!(version)]).await?;
    Ok(())
}
async fn access_token(
    state: &AppState,
    actor: &Actor,
    key: &str,
    provider: &Provider,
) -> Result<(Tokens, i64)> {
    for _ in 0..250 {
        let row = account(state, actor, key).await?;
        if reconnect(state, &row) {
            return Err(ProviderFailure::Authorization.error());
        }
        let tokens: Tokens = models::open(state, &actor.tenant_id, s(&row, "encrypted_tokens"))?;
        let version = n(&row, "version");
        if n(&row, "access_expires_at") > now() + 60_000 {
            return Ok((tokens, version));
        }
        if n(&row, "refresh_expires_at") <= now() {
            mark_reconnect(state, actor, key, version).await?;
            return Err(ProviderFailure::Authorization.error());
        }
        if !s(&row, "refresh_lease").is_empty() && n(&row, "refresh_lease_until") <= now() {
            // A crashed refresh may already have consumed its single-use token.
            mark_reconnect(state, actor, key, version).await?;
            return Err(AppError::bad("无法确认飞书授权刷新结果，请重新连接飞书"));
        }
        let lease = id();
        let claimed = state.db.exec("UPDATE bot_feishu_accounts SET refresh_lease=?,refresh_lease_until=? WHERE connector_id=? AND tenant_id=? AND user_id=? AND enabled=1 AND needs_reconnect=0 AND version=? AND refresh_lease='' AND refresh_lease_until<?",vec![json!(lease),json!(now()+60_000),json!(key),json!(actor.tenant_id),json!(actor.id),json!(version),json!(now())]).await?;
        if claimed == 0 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let refreshed = provider
            .grant(
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", s(&row, "client_id")),
                    ("refresh_token", &tokens.refresh_token),
                    ("resource", RESOURCE),
                ],
                Some(&tokens),
            )
            .await;
        match refreshed {
            Ok(grant) => {
                if !["search-doc", "fetch-doc"]
                    .iter()
                    .all(|tool| scope_allows(&grant.tokens.scope, tool))
                {
                    mark_reconnect(state, actor, key, version).await?;
                    return Err(ProviderFailure::Authorization.error());
                }
                let encrypted = models::seal(state, &actor.tenant_id, &grant.tokens)?;
                let changed = state.db.exec("UPDATE bot_feishu_accounts SET encrypted_tokens=?,access_expires_at=?,refresh_expires_at=?,version=version+1,refresh_lease='',refresh_lease_until=0,updated_at=? WHERE connector_id=? AND tenant_id=? AND user_id=? AND enabled=1 AND version=? AND refresh_lease=?",vec![json!(encrypted),json!(grant.access_expires_at),json!(grant.refresh_expires_at),json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id),json!(version),json!(lease)]).await?;
                if changed == 1 {
                    return Ok((grant.tokens, version + 1));
                }
                // Reconnect/disconnect won the CAS. Never deliver stale credentials.
            }
            Err(error) => {
                // Any ambiguous failure may have rotated the one-use refresh token.
                mark_reconnect(state, actor, key, version).await?;
                return Err(if matches!(error, ProviderFailure::Authorization) {
                    error.error()
                } else {
                    AppError::bad("无法确认飞书授权刷新结果，请重新连接飞书")
                });
            }
        }
    }
    Err(AppError::bad("飞书授权正在刷新，请稍后重试"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolsQuery {
    connector_id: String,
}
pub async fn tools(
    State(state): State<AppState>,
    actor: Actor,
    Query(input): Query<ToolsQuery>,
) -> Result<Json<Value>> {
    actor.browser()?;
    Ok(Json(
        json!({"tools":catalog_with(&state,&actor,&input.connector_id,&Provider::official()?).await?}),
    ))
}
async fn catalog_with(
    state: &AppState,
    actor: &Actor,
    key: &str,
    provider: &Provider,
) -> Result<Vec<Value>> {
    let (tokens, version) = access_token(state, actor, key, provider).await?;
    match provider.catalog(&tokens.access_token, &tokens.scope).await {
        Ok((catalog, _)) => {
            if !practical_catalog(&catalog) {
                mark_reconnect(state, actor, key, version).await?;
                return Err(ProviderFailure::Authorization.error());
            }
            let changed=state.db.exec("UPDATE bot_feishu_accounts SET tool_catalog=?,updated_at=? WHERE connector_id=? AND tenant_id=? AND user_id=? AND enabled=1 AND version=?",vec![json!(serde_json::to_string(&catalog).map_err(|_| ProviderFailure::Invalid.error())?),json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id),json!(version)]).await?;
            if changed != 1 {
                return Err(AppError::bad("飞书连接已变化，请重新选择"));
            }
            Ok(catalog)
        }
        Err(error) => {
            if matches!(error, ProviderFailure::Authorization) {
                mark_reconnect(state, actor, key, version).await?;
            }
            Err(error.error())
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    tool: String,
    arguments: serde_json::Map<String, Value>,
}
pub(crate) async fn call(
    state: &AppState,
    actor: &Actor,
    key: &str,
    input: &Value,
) -> Result<Value> {
    call_with(state, actor, key, input, &Provider::official()?).await
}
pub(crate) async fn test(state: &AppState, actor: &Actor, key: &str) -> Result<Value> {
    catalog_with(state, actor, key, &Provider::official()?).await?;
    Ok(json!({"success":true,"message":"飞书文档搜索与读取连接有效"}))
}
async fn call_with(
    state: &AppState,
    actor: &Actor,
    key: &str,
    input: &Value,
    provider: &Provider,
) -> Result<Value> {
    let call: Call = serde_json::from_value(input.clone())
        .map_err(|_| AppError::bad("飞书 input 需包含 tool 与 arguments 对象"))?;
    if !READ_TOOLS.contains(&call.tool.as_str()) || input.to_string().len() > 32000 {
        return Err(AppError::forbidden());
    }
    let (tokens, version) = access_token(state, actor, key, provider).await?;
    if !scope_allows(&tokens.scope, &call.tool) {
        return Err(AppError::forbidden());
    }
    let result = async {
        let (catalog, session) = provider
            .catalog(&tokens.access_token, &tokens.scope)
            .await?;
        let tool = catalog
            .iter()
            .find(|v| v["name"] == call.tool)
            .ok_or(ProviderFailure::Authorization)?;
        validate_arguments(
            &Value::Object(call.arguments.clone()),
            &tool["inputSchema"],
            0,
        )
        .map_err(|_| ProviderFailure::Invalid)?;
        let (result, _) = provider
            .rpc(
                &tokens.access_token,
                Some(&session),
                "tools/call",
                json!({"name":call.tool,"arguments":call.arguments}),
                Some("call"),
            )
            .await?;
        if result["isError"] == true {
            return Err(ProviderFailure::Invalid);
        }
        Ok(result)
    }
    .await;
    // A concurrent disconnect/reconnect must not deliver results from an older grant.
    let row = account(state, actor, key).await?;
    if n(&row, "version") != version {
        return Err(AppError::bad("飞书连接已变化，请重试"));
    }
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            if matches!(error, ProviderFailure::Authorization) {
                mark_reconnect(state, actor, key, version).await?;
            }
            Err(error.error())
        }
    }
}
// Validate common JSON Schema constraints; the official MCP server validates the
// full schema. This is not a permission boundary: exact read-tool names are.
fn validate_arguments(value: &Value, schema: &Value, depth: usize) -> std::result::Result<(), ()> {
    if depth > 24 {
        return Err(());
    }
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return Err(());
        }
    }
    if let Some(kind) = schema["type"].as_str() {
        if !match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "number" => value.is_number(),
            "null" => value.is_null(),
            _ => false,
        } {
            return Err(());
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for key in required {
                if !key.as_str().is_some_and(|k| object.contains_key(k)) {
                    return Err(());
                }
            }
        }
        for (key, item) in object {
            if let Some(child) = schema["properties"].get(key) {
                validate_arguments(item, child, depth + 1)?;
            } else if schema["additionalProperties"] == false {
                return Err(());
            }
        }
    }
    if let Some(items) = value.as_array() {
        if schema.get("items").is_some() {
            for item in items {
                validate_arguments(item, &schema["items"], depth + 1)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/support/bot_feishu_tests.rs"]
mod tests;
