//! Trusted server-to-server TencentDB Memory APIs. Never expose this proxy to clients.
use crate::{
    auth::{self, Actor},
    core_skill_registry,
    error::{AppError, Result},
    AppState,
};
use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};
use std::time::Duration;

pub fn configured_core(state: &AppState) -> bool {
    !state.config.memory_core_url.is_empty() && !state.config.memory_core_token.is_empty()
}
pub fn configured_knowledge(state: &AppState) -> bool {
    !state.config.memory_knowledge_url.is_empty() && !state.config.memory_knowledge_token.is_empty()
}
pub fn identity(actor: &Actor, knowledge: bool) -> Value {
    let tenant = auth::hash(&format!("zxh-tenant\n{}", actor.tenant_id));
    let owner = auth::hash(&format!("zxh-owner\n{}\n{}", actor.tenant_id, actor.id));
    json!({
        "team_id":format!("zxh-team-{}", if knowledge { &owner } else { &tenant }),
        "user_id":format!("zxh-user-{owner}"),
        "agent_id":format!("zxh-agent-{owner}"),
    })
}
pub async fn post_core(
    state: &AppState,
    actor: &Actor,
    path: &str,
    payload: Value,
) -> Result<Value> {
    request(state, actor, false, path, payload).await
}
pub async fn post_knowledge(
    state: &AppState,
    actor: &Actor,
    path: &str,
    payload: Value,
) -> Result<Value> {
    request(state, actor, true, path, payload).await
}
/// Native registry control plane, reachable only from trusted backend code.
/// Metadata schemas must receive their actual native IDs without proxy overrides.
pub(crate) async fn post_core_metadata(
    state: &AppState,
    path: &str,
    payload: Value,
    user_key: Option<&str>,
) -> Result<Value> {
    if !path.starts_with("/v3/meta/") && path != "/v3/internal/meta/user/list-by-instance" {
        return Err(AppError::bad("原生技能注册接口无效"));
    }
    send(
        state,
        &state.config.memory_core_url,
        &state.config.memory_core_token,
        path,
        &payload,
        user_key,
    )
    .await
}
async fn request(
    state: &AppState,
    actor: &Actor,
    knowledge: bool,
    path: &str,
    mut payload: Value,
) -> Result<Value> {
    let (endpoint, token) = if knowledge {
        (
            &state.config.memory_knowledge_url,
            &state.config.memory_knowledge_token,
        )
    } else {
        (
            &state.config.memory_core_url,
            &state.config.memory_core_token,
        )
    };
    if endpoint.is_empty() || token.is_empty() {
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            if knowledge {
                "Wiki 与代码图谱服务尚未配置，请设置 MEMORY_KNOWLEDGE_URL 和 MEMORY_KNOWLEDGE_TOKEN"
            } else {
                "长期记忆服务尚未配置，请设置 MEMORY_CORE_URL 和 MEMORY_CORE_TOKEN"
            }
            .into(),
        ));
    }
    if !path.starts_with("/v3/") || path.contains(['?', '#', '\\']) || path.contains("..") {
        return Err(AppError::bad("记忆服务接口无效"));
    }
    let body = payload
        .as_object_mut()
        .ok_or_else(|| AppError::bad("记忆请求必须为对象"))?;
    let ids = if !knowledge && path.starts_with("/v3/skill/") {
        core_skill_registry::ensure(state, actor).await?
    } else {
        identity(actor, knowledge)
    };
    for (key, value) in ids.as_object().unwrap() {
        body.insert(key.clone(), value.clone());
    }
    body.insert("space_id".into(), json!(state.config.memory_service_id));
    if !knowledge {
        body.entry("session_id").or_insert_with(|| {
            json!(format!(
                "zxh-{}",
                auth::hash(&format!("{}\n{}", actor.tenant_id, actor.id))
            ))
        });
    }
    if payload.to_string().len() > if knowledge { 6_000_000 } else { 1_000_000 } {
        return Err(AppError::bad("记忆请求超过服务大小限制"));
    }
    send(state, endpoint, token, path, &payload, None).await
}
async fn send(
    state: &AppState,
    endpoint: &str,
    token: &str,
    path: &str,
    payload: &Value,
    user_key: Option<&str>,
) -> Result<Value> {
    let operation = async {
        let mut request = state
            .http
            .post(format!("{}{}", endpoint.trim_end_matches('/'), path))
            .bearer_auth(token)
            .header("x-tdai-service-id", &state.config.memory_service_id)
            .json(payload);
        if let Some(key) = user_key {
            request = request.header("x-tdai-user-key", key);
        }
        let mut response = request.send().await.map_err(|_| {
            AppError(
                StatusCode::SERVICE_UNAVAILABLE,
                "记忆服务暂时无法连接".into(),
            )
        })?;
        if !response.status().is_success() {
            return Err(AppError(
                StatusCode::BAD_GATEWAY,
                format!("记忆服务返回 HTTP {}", response.status().as_u16()),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AppError::bad("记忆服务响应中断"))?
        {
            if bytes.len() + chunk.len() > 2_000_000 {
                return Err(AppError::bad("记忆服务响应超过 2 MB"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let result: Value = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::bad("记忆服务响应不是有效 JSON"))?;
        if result["code"].as_i64() != Some(0) {
            return Err(AppError(
                StatusCode::BAD_GATEWAY,
                format!("记忆服务业务错误 {}", result["code"].as_i64().unwrap_or(-1)),
            ));
        }
        Ok(result["data"].clone())
    };
    tokio::time::timeout(Duration::from_secs(25), operation)
        .await
        .map_err(|_| AppError(StatusCode::GATEWAY_TIMEOUT, "记忆服务请求超时".into()))?
}
async fn health(state: &AppState, endpoint: &str) -> bool {
    if endpoint.is_empty() {
        return false;
    }
    matches!(tokio::time::timeout(Duration::from_secs(2), state.http.get(format!("{}/health", endpoint.trim_end_matches('/'))).send()).await,
        Ok(Ok(response)) if response.status().is_success())
}
pub async fn status(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let (core, knowledge) = tokio::join!(
        health(&state, &state.config.memory_core_url),
        health(&state, &state.config.memory_knowledge_url)
    );
    Ok(Json(
        json!({"core":{"configured":configured_core(&state),"available":core},"knowledge":{"configured":configured_knowledge(&state),"available":knowledge}}),
    ))
}
