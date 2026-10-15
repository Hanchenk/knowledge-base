//! Per-account cloud computers. Containers expire; private sessions and outputs do not.
use crate::{
    acl,
    auth::Actor,
    db::{n, now, s, Record},
    error::{AppError, Result},
    harness, studio, AppState,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

pub const IDLE_TIMEOUT_SECONDS: i64 = 1800;

/// Native task homes contain private evidence too. An allowlist is passed to
/// the container lifecycle so stale evidence can be retained outside its mounts.
pub(crate) async fn access(state: &AppState, actor: &Actor) -> Result<Value> {
    let tasks = state
        .db
        .rows(
            "SELECT id,citations FROM bot_tasks WHERE tenant_id=? AND user_id=? ORDER BY id",
            vec![json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    access_rows(state, actor, &tasks, true).await
}
async fn access_rows(
    state: &AppState,
    actor: &Actor,
    tasks: &[Record],
    user_active: bool,
) -> Result<Value> {
    let rights = if user_active {
        acl::all_rights(state, actor).await?
    } else {
        HashMap::new()
    };
    let mut documents = HashMap::new();
    let mut authorized = Vec::new();
    let mut restricted = Vec::new();
    for task in tasks {
        let citations = serde_json::from_str::<Vec<Value>>(s(task, "citations"));
        let mut visible = user_active && citations.is_ok();
        if let Ok(citations) = citations {
            for citation in citations {
                let space = citation["space_id"].as_str().unwrap_or("");
                if !rights.get(space).is_some_and(|r| r.can_view) {
                    visible = false;
                    break;
                }
                let Some(version) = citation["version"].as_i64() else {
                    visible = false;
                    break;
                };
                let key = (
                    citation["document_id"].as_str().unwrap_or("").to_owned(),
                    version,
                );
                let current = match documents.get(&key) {
                    Some(current) => *current,
                    None => {
                        let found = state
                            .db
                            .one(
                                "SELECT id FROM documents WHERE id=? AND tenant_id=? AND version=? AND deleted=0",
                                vec![json!(key.0), json!(actor.tenant_id), json!(version)],
                            )
                            .await?
                            .is_some();
                        documents.insert(key, found);
                        found
                    }
                };
                if !current {
                    visible = false;
                    break;
                }
            }
        }
        if visible {
            authorized.push(s(task, "id").to_owned());
        } else {
            restricted.push(s(task, "id").to_owned());
        }
    }
    Ok(json!({"authorized_task_ids":authorized,"restricted_task_ids":restricted}))
}

async fn task_counts(state: &AppState, actor: &Actor) -> Result<(i64, i64, Vec<Value>)> {
    let tasks = state.db.rows("SELECT id,worker_token,status,options FROM bot_tasks WHERE tenant_id=? AND user_id=? AND (status='queued' OR (status='running' AND lease_until>?)) AND NOT EXISTS (SELECT task_id FROM bot_local_execution WHERE task_id=bot_tasks.id)", vec![json!(actor.tenant_id), json!(actor.id), json!(now())]).await?;
    let mut active = 0;
    let mut pending = 0;
    let mut live_tasks = Vec::new();
    for row in tasks {
        if serde_json::from_str::<Value>(s(&row, "options"))
            .is_ok_and(|options| options["runtime"] == "deepseek-harness")
        {
            if s(&row, "status") == "running" {
                active += 1;
                live_tasks.push(json!({"tenant_id":actor.tenant_id,"user_id":actor.id,"task_id":s(&row,"id"),"lease_token":s(&row,"worker_token")}));
            } else {
                pending += 1;
            }
        }
    }
    Ok((active, pending, live_tasks))
}

async fn runtime(state: &AppState, operation: &str, mut input: Value) -> Result<Value> {
    input["operation"] = json!(operation);
    input["root"] = json!(state.config.harness_path.to_string_lossy());
    input["image"] = json!(state.config.harness_image);
    input["bridge_host"] = json!(state.config.harness_bridge_host);
    let mut command = Command::new(&state.config.agent_node);
    command
        .arg(harness::script(state, "harness-cloud.mjs"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("NODE_NO_WARNINGS", "1");
    // Container management does not inherit model, storage, or application credentials.
    for key in ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            AppError(
                StatusCode::SERVICE_UNAVAILABLE,
                "云端电脑暂未就绪，请联系管理员".into(),
            )
        })?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .await
        .map_err(|_| AppError::bad("云端电脑通信失败，请重试"))?;
    let output = tokio::time::timeout(
        Duration::from_secs(if operation == "connect" { 180 } else { 90 }),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        AppError(
            StatusCode::GATEWAY_TIMEOUT,
            "云端电脑操作超时，请刷新连接状态".into(),
        )
    })?
    .map_err(|_| AppError::bad("云端电脑通信失败，请重试"))?;
    if output.stdout.len() > 100_000 {
        return Err(AppError::bad("云端电脑返回状态无效"));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "云端电脑暂未就绪，请联系管理员".into(),
        )
    })?;
    if value["ok"] != true {
        let code = value["code"].as_str().unwrap_or("");
        tracing::warn!(operation, code, "Cloud computer operation failed");
        return Err(if code == "CLOUD_SESSION_BUSY" {
            AppError(
                StatusCode::CONFLICT,
                "云端电脑正在执行任务，请等待完成或先取消任务".into(),
            )
        } else {
            AppError(
                StatusCode::SERVICE_UNAVAILABLE,
                "云端电脑暂时无法连接，请重试或联系管理员".into(),
            )
        });
    }
    Ok(value)
}

fn public_status(value: &Value, available: bool) -> Value {
    let connected = value["connected"] == true && value["status"] == "running";
    json!({
        "available":available,
        "connected":connected,
        "state":if connected { "running" } else if available { "stopped" } else { "unavailable" },
        "idle_timeout_seconds":IDLE_TIMEOUT_SECONDS,
        "last_activity_at":value["last_activity_at"].as_i64(),
        "expires_at":if connected { value["expires_at"].as_i64() } else { None },
        "active_tasks":value["active_tasks"].as_u64().unwrap_or(0),
        "pending_tasks":value["pending_tasks"].as_u64().unwrap_or(0),
        "persistent":true
    })
}

async fn owner_operation(state: &AppState, actor: &Actor, operation: &str) -> Result<Value> {
    actor.browser()?;
    if !state.config.harness_enabled {
        if operation == "status" {
            let mut value = public_status(&json!({}), false);
            value["error"] = json!("云端电脑暂未开放，请联系管理员");
            return Ok(value);
        }
        // An administrator disabling execution must not prevent safe disconnection.
        if operation != "disconnect" {
            return Err(AppError(
                StatusCode::SERVICE_UNAVAILABLE,
                "云端电脑暂未开放，请联系管理员".into(),
            ));
        }
    }
    let (busy, pending, live_tasks) = task_counts(state, actor).await?;
    if operation == "disconnect" && busy + pending > 0 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "云端电脑有排队或执行中的任务，请等待完成或先取消任务".into(),
        ));
    }
    let permission = access(state, actor).await?;
    let value = runtime(
        state,
        operation,
        json!({"tenant_id":actor.tenant_id,"user_id":actor.id,"active_tasks":busy,"live_tasks":live_tasks,"authorized_task_ids":permission["authorized_task_ids"],"restricted_task_ids":permission["restricted_task_ids"]}),
    )
    .await;
    if operation == "status" && value.is_err() {
        let mut result = public_status(&json!({}), false);
        result["error"] = json!("云端电脑暂未就绪，请联系管理员");
        return Ok(result);
    }
    let mut value = value?;
    value["active_tasks"] = json!(busy.max(value["active_tasks"].as_i64().unwrap_or(0)));
    value["pending_tasks"] = json!(pending);
    let ready = state.config.harness_enabled
        && (value["connected"] == true || harness::available(state).await);
    Ok(public_status(&value, ready))
}

pub async fn status(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    Ok(Json(owner_operation(&state, &actor, "status").await?))
}
pub async fn connect(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    Ok(Json(owner_operation(&state, &actor, "connect").await?))
}
pub async fn heartbeat(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    Ok(Json(owner_operation(&state, &actor, "heartbeat").await?))
}
pub async fn disconnect(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    Ok(Json(owner_operation(&state, &actor, "disconnect").await?))
}

/// Cleanup is fenced to one invocation; a retry or another task sharing the
/// account's cloud computer must keep running.
pub(crate) async fn cancel_task(
    state: &AppState,
    actor: &Actor,
    context: &crate::bot::Context,
) -> Result<Value> {
    state
        .db
        .one(
            "SELECT id FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
            vec![
                json!(context.task_id),
                json!(actor.tenant_id),
                json!(actor.id),
            ],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    runtime(
        state,
        "cancel-task",
        json!({"tenant_id":actor.tenant_id,"user_id":actor.id,"task_id":context.task_id,"lease_token":context.token}),
    )
    .await
}

/// A separate loop prevents long model turns from delaying idle container cleanup.
pub async fn worker(state: AppState) {
    let mut timer = tokio::time::interval(Duration::from_secs(60));
    loop {
        timer.tick().await;
        if !harness::script(&state, "harness-cloud.mjs").is_file()
            || !state.config.harness_path.is_dir()
        {
            continue;
        }
        if let Err(error) = reap(&state).await {
            tracing::warn!(status=%error.0, "Cloud computer idle cleanup failed");
        }
    }
}
pub async fn reap(state: &AppState) -> Result<Value> {
    // A native lease admitted after this DB snapshot must wait for the next
    // scan; otherwise an older snapshot could cancel a newly started task.
    let fence_snapshot_at = now();
    let tasks = state.db.rows("SELECT t.id,t.tenant_id,t.user_id,t.worker_token,t.options FROM bot_tasks t JOIN users u ON u.id=t.user_id AND u.tenant_id=t.tenant_id WHERE u.active=1 AND t.status='running' AND t.lease_until>? AND NOT EXISTS (SELECT task_id FROM bot_local_execution WHERE task_id=t.id)", vec![json!(now())]).await?;
    let live_tasks: Vec<Value> = tasks
        .into_iter()
        .filter(|row| {
            serde_json::from_str::<Value>(s(row, "options"))
                .is_ok_and(|options| options["runtime"] == "deepseek-harness")
        })
        .map(|row| json!({"tenant_id":s(&row,"tenant_id"),"user_id":s(&row,"user_id"),"task_id":s(&row,"id"),"lease_token":s(&row,"worker_token")}))
        .collect();
    let live_owners: Vec<Value> = live_tasks
        .iter()
        .map(|task| json!({"tenant_id":task["tenant_id"],"user_id":task["user_id"]}))
        .collect();
    let rows = state.db.rows("SELECT t.id,t.tenant_id,t.user_id,t.citations,u.active,u.role,u.department_id FROM bot_tasks t JOIN users u ON u.id=t.user_id AND u.tenant_id=t.tenant_id ORDER BY t.tenant_id,t.user_id,t.id", vec![]).await?;
    let mut owners: HashMap<(String, String), Vec<Record>> = HashMap::new();
    for row in rows {
        owners
            .entry((s(&row, "tenant_id").into(), s(&row, "user_id").into()))
            .or_default()
            .push(row);
    }
    let mut task_access = Vec::new();
    for ((tenant, user), tasks) in owners {
        let actor = Actor {
            id: user,
            tenant_id: tenant,
            role: s(&tasks[0], "role").into(),
            department_id: s(&tasks[0], "department_id").into(),
            scopes: None,
            key_id: None,
        };
        let mut permission =
            access_rows(state, &actor, &tasks, n(&tasks[0], "active") == 1).await?;
        permission["tenant_id"] = json!(actor.tenant_id);
        permission["user_id"] = json!(actor.id);
        task_access.push(permission);
    }
    runtime(
        state,
        "reap",
        json!({"live_owners":live_owners,"live_tasks":live_tasks,"fence_snapshot_at":fence_snapshot_at,"task_access":task_access}),
    )
    .await
}

#[derive(Deserialize)]
pub struct FilesQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}
fn preview_type(name: &str) -> Option<&'static str> {
    match name.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "md" | "txt" | "csv" | "json" | "py" | "js" | "ts" | "css" | "html" | "htm" | "svg"
        | "log" | "xml" | "yaml" | "yml" | "mjs" | "cjs" | "jsx" | "tsx" | "sql" | "rs"
        | "toml" => Some("text/plain; charset=utf-8"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}
pub async fn files(
    State(state): State<AppState>,
    actor: Actor,
    Query(query): Query<FilesQuery>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let limit = query.limit.unwrap_or(100);
    let offset = query.offset.unwrap_or(0);
    if !(1..=100).contains(&limit) || offset > 10_000 {
        return Err(AppError::bad("文件分页参数无效"));
    }
    let rows = state.db.rows("SELECT a.id,a.task_id,a.name,a.size,a.created_at,t.title AS task_title,t.citations FROM bot_artifacts a JOIN bot_tasks t ON t.id=a.task_id WHERE t.tenant_id=? AND t.user_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?", vec![json!(actor.tenant_id), json!(actor.id), json!(limit+1), json!(offset)]).await?;
    let has_more = rows.len() > limit;
    let mut visibility = HashMap::new();
    let mut output = Vec::new();
    for row in rows.into_iter().take(limit) {
        let task = s(&row, "task_id");
        let accessible = match visibility.get(task) {
            Some(value) => *value,
            None => {
                let citations: Value = serde_json::from_str(s(&row, "citations"))
                    .map_err(|_| AppError::forbidden())?;
                let value = studio::valid_evidence(
                    &state,
                    &actor,
                    citations.as_array().ok_or_else(AppError::forbidden)?,
                )
                .await?;
                visibility.insert(task.to_owned(), value);
                value
            }
        };
        if !accessible {
            continue;
        }
        let key = s(&row, "id");
        let content_type = preview_type(s(&row, "name"));
        output.push(json!({"id":key,"task_id":task,"task_title":s(&row,"task_title"),"name":s(&row,"name"),"kind":if content_type.is_some_and(|v|v.starts_with("image/")){"image"}else if content_type==Some("application/pdf"){"pdf"}else if content_type.is_some(){"text"}else{"file"},"size":n(&row,"size"),"created_at":n(&row,"created_at"),"url":format!("/api/bot/artifacts/{key}"),"download_url":format!("/api/bot/artifacts/{key}"),"preview_url":content_type.map(|_|format!("/api/bot/artifacts/{key}/preview")),"previewable":content_type.is_some(),"content_type":content_type.unwrap_or("application/octet-stream")}));
    }
    Ok(Json(
        json!({"files":output,"limit":limit,"offset":offset,"has_more":has_more,"next_offset":has_more.then_some(offset+limit)}),
    ))
}

fn valid_preview(content_type: &str, data: &[u8]) -> bool {
    match content_type {
        "text/plain; charset=utf-8" => std::str::from_utf8(data).is_ok(),
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(b"\xff\xd8\xff"),
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/webp" => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "application/pdf" => data.starts_with(b"%PDF-"),
        _ => false,
    }
}
async fn accessible_artifact(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    actor.browser()?;
    let row = state.db.one("SELECT a.name,a.storage_key,t.citations FROM bot_artifacts a JOIN bot_tasks t ON t.id=a.task_id WHERE a.id=? AND t.tenant_id=? AND t.user_id=?", vec![json!(key),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)?;
    let citations: Value =
        serde_json::from_str(s(&row, "citations")).map_err(|_| AppError::forbidden())?;
    if !studio::valid_evidence(
        state,
        actor,
        citations.as_array().ok_or_else(AppError::forbidden)?,
    )
    .await?
    {
        return Err(AppError::forbidden());
    }
    Ok(row)
}

pub async fn preview(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Response> {
    let row = accessible_artifact(&state, &actor, &key).await?;
    let content_type =
        preview_type(s(&row, "name")).ok_or_else(|| AppError::bad("此文件请下载后查看"))?;
    let data = state.storage.get(s(&row, "storage_key")).await?;
    if !valid_preview(content_type, &data) {
        return Err(AppError::bad("此文件无法在线预览，请下载后查看"));
    }
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, "inline")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'",
        )
        .body(Body::from(data))
        .map_err(|_| AppError::bad("无法预览成果"))
}

/// A separate navigated document has its own CSP instead of inheriting the
/// application page's policy through srcDoc. CSP sandbox keeps its origin
/// opaque even when the URL is opened directly outside the preview iframe.
pub async fn render(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Response> {
    let row = accessible_artifact(&state, &actor, &key).await?;
    let extension = s(&row, "name")
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "html" | "htm" | "svg") {
        return Err(AppError::bad("此文件不支持交互预览"));
    }
    let data = state.storage.get(s(&row, "storage_key")).await?;
    if std::str::from_utf8(&data).is_err() {
        return Err(AppError::bad("此文件无法在线预览，请下载后查看"));
    }
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_DISPOSITION, "inline")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        )
        .body(Body::from(data))
        .map_err(|_| AppError::bad("无法预览成果"))
}
