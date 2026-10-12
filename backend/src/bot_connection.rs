//! Browser approval of a Desktop-minted credential; no manual pairing code.
use crate::{
    auth::{self, Actor},
    db::{id, n, now, s},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct Begin {
    token: String,
    name: String,
    workspace_id: String,
    workspace_title: String,
}
fn credential(token: &str) -> Result<()> {
    if token.len() != 67
        || !token.starts_with("zd_")
        || !token[3..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AppError::bad("设备凭据无效"));
    }
    Ok(())
}
fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(AppError::bad("连接参数无效或过长"));
    }
    Ok(())
}
pub async fn begin(State(state): State<AppState>, Json(input): Json<Begin>) -> Result<Json<Value>> {
    credential(&input.token)?;
    text(&input.name, 80)?;
    text(&input.workspace_id, 200)?;
    text(&input.workspace_title, 120)?;
    state
        .db
        .exec(
            "DELETE FROM bot_connections WHERE expires_at<?",
            vec![json!(now())],
        )
        .await?;
    let token_hash = auth::hash(&input.token);
    if state
        .db
        .one(
            "SELECT id FROM bot_devices WHERE token_hash=?",
            vec![json!(token_hash)],
        )
        .await?
        .is_some()
    {
        return Err(AppError(StatusCode::CONFLICT, "请使用新的连接请求".into()));
    }
    let expires = now() + 600000;
    state.db.exec("INSERT INTO bot_connections(id,token_hash,name,workspace_id,workspace_title,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(token_hash) DO NOTHING", vec![json!(id()), json!(token_hash), json!(input.name), json!(input.workspace_id), json!(input.workspace_title), json!(expires)]).await?;
    let row = state
        .db
        .one(
            "SELECT * FROM bot_connections WHERE token_hash=?",
            vec![json!(token_hash)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    if s(&row, "name") != input.name
        || s(&row, "workspace_id") != input.workspace_id
        || s(&row, "workspace_title") != input.workspace_title
    {
        return Err(AppError(
            StatusCode::CONFLICT,
            "连接请求参数已改变，请重试".into(),
        ));
    }
    Ok(Json(json!({"id":row["id"],"expires_at":row["expires_at"]})))
}
pub async fn details(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let row = state.db.one("SELECT name,workspace_title,expires_at,device_id FROM bot_connections WHERE id=? AND expires_at>?", vec![json!(key), json!(now())]).await?.ok_or_else(|| AppError::bad("连接请求已过期，请从客户端重新连接"))?;
    if !s(&row, "device_id").is_empty() {
        crate::bot_bridge::owned_device(&state, &actor, s(&row, "device_id")).await?;
    }
    Ok(Json(
        json!({"name":row["name"],"workspace_title":row["workspace_title"],"expires_at":row["expires_at"],"connected":!s(&row,"device_id").is_empty()}),
    ))
}
pub async fn approve(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let mut tx = state.db.pool.begin().await?;
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_connections SET expires_at=expires_at WHERE id=? AND expires_at>?",
            vec![json!(key), json!(now())],
        )
        .await?
        == 0
    {
        return Err(AppError::bad("连接请求已过期，请从客户端重新连接"));
    }
    let row = state
        .db
        .tx_one(
            &mut tx,
            "SELECT * FROM bot_connections WHERE id=?",
            vec![json!(key)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    if !s(&row, "device_id").is_empty() {
        let device = state
            .db
            .tx_one(
                &mut tx,
                "SELECT id FROM bot_devices WHERE id=? AND tenant_id=? AND user_id=? AND active=1",
                vec![
                    row["device_id"].clone(),
                    json!(actor.tenant_id),
                    json!(actor.id),
                ],
            )
            .await?
            .ok_or_else(AppError::forbidden)?;
        tx.commit().await?;
        return Ok(Json(json!({"id":device["id"]})));
    }
    // Serialize quota checks with both the old pairing endpoint and account revocation.
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE users SET active=active WHERE id=? AND tenant_id=? AND active=1",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        == 0
    {
        return Err(AppError::forbidden());
    }
    let count = state.db.tx_one(&mut tx,"SELECT COUNT(*) AS total FROM bot_devices WHERE user_id=? AND tenant_id=? AND active=1",vec![json!(actor.id),json!(actor.tenant_id)]).await?.unwrap();
    if n(&count, "total") >= 8 {
        return Err(AppError::bad("最多连接 8 台本地设备，请先解除旧连接"));
    }
    let device = id();
    state.db.tx_exec(&mut tx,"INSERT INTO bot_devices(id,tenant_id,user_id,token_hash,name,workspace_id,workspace_title,last_seen,created_at) VALUES(?,?,?,?,?,?,?,0,?)",vec![json!(device),json!(actor.tenant_id),json!(actor.id),row["token_hash"].clone(),row["name"].clone(),row["workspace_id"].clone(),row["workspace_title"].clone(),json!(now())]).await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_connections SET device_id=? WHERE id=?",
            vec![json!(device), json!(key)],
        )
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":device})))
}
#[derive(Deserialize)]
pub struct Poll {
    id: String,
    token: String,
}
pub async fn poll(State(state): State<AppState>, Json(input): Json<Poll>) -> Result<Json<Value>> {
    credential(&input.token)?;
    let row = state
        .db
        .one(
            "SELECT device_id FROM bot_connections WHERE id=? AND token_hash=? AND expires_at>?",
            vec![
                json!(input.id),
                json!(auth::hash(&input.token)),
                json!(now()),
            ],
        )
        .await?
        .ok_or_else(|| AppError::bad("连接请求已过期或无效，请重新连接"))?;
    if s(&row, "device_id").is_empty() {
        return Ok(Json(json!({"status":"pending"})));
    }
    let changed = state.db.exec("UPDATE bot_devices SET last_seen=? WHERE id=? AND active=1 AND EXISTS (SELECT id FROM users WHERE id=bot_devices.user_id AND tenant_id=bot_devices.tenant_id AND active=1)",vec![json!(now()),row["device_id"].clone()]).await?;
    if changed == 0 {
        return Err(AppError::unauthorized());
    }
    Ok(Json(json!({"status":"connected","id":row["device_id"]})))
}
#[derive(Deserialize)]
pub struct Cancel {
    token: String,
}
pub async fn cancel(
    State(state): State<AppState>,
    Json(input): Json<Cancel>,
) -> Result<Json<Value>> {
    credential(&input.token)?;
    let token_hash = auth::hash(&input.token);
    let mut tx = state.db.pool.begin().await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_connections SET expires_at=0 WHERE token_hash=?",
            vec![json!(token_hash)],
        )
        .await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_devices SET active=0 WHERE token_hash=?",
            vec![json!(token_hash)],
        )
        .await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_tasks SET status='cancelled',worker_token=NULL,error='客户端已取消连接',updated_at=? WHERE id IN (SELECT e.task_id FROM bot_local_execution e JOIN bot_devices d ON d.id=e.device_id WHERE d.token_hash=?) AND status IN ('queued','running','waiting')",vec![json!(now()),json!(token_hash)]).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
