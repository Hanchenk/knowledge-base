//! Outbound, account-bound Desktop bridge. A device credential grants only its assigned tasks.
use crate::{
    auth::{self, Actor},
    bot,
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{FromRequestParts, Path, State},
    http::{request::Parts, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Any, Transaction};

pub struct Device {
    id: String,
    actor: Actor,
}
impl FromRequestParts<AppState> for Device {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| v.starts_with("zd_"))
            .ok_or_else(AppError::unauthorized)?;
        let row = state.db.one("SELECT d.id AS device_id,u.* FROM bot_devices d JOIN users u ON u.id=d.user_id AND u.tenant_id=d.tenant_id WHERE d.token_hash=? AND d.active=1 AND u.active=1",vec![json!(auth::hash(token))]).await?.ok_or_else(AppError::unauthorized)?;
        Ok(Self {
            id: s(&row, "device_id").into(),
            actor: Actor {
                id: s(&row, "id").into(),
                tenant_id: s(&row, "tenant_id").into(),
                department_id: s(&row, "department_id").into(),
                role: s(&row, "role").into(),
                scopes: None,
                key_id: None,
            },
        })
    }
}
fn valid_text(v: &str, max: usize) -> Result<()> {
    if v.trim().is_empty() || v.chars().count() > max || v.contains('\0') {
        return Err(AppError::bad("本地连接参数无效或过长"));
    }
    Ok(())
}
fn conflict(message: &str) -> AppError {
    AppError(StatusCode::CONFLICT, message.into())
}
async fn fence(state: &AppState, tx: &mut Transaction<'_, Any>, device: &Device) -> Result<()> {
    let changed=state.db.tx_exec(tx,"UPDATE bot_devices SET last_seen=? WHERE id=? AND active=1 AND EXISTS (SELECT id FROM users WHERE id=bot_devices.user_id AND tenant_id=bot_devices.tenant_id AND active=1)",vec![json!(now()),json!(device.id)]).await?;
    if changed == 0 {
        return Err(AppError::unauthorized());
    }
    Ok(())
}
pub async fn owned_device(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    state.db.one("SELECT id,name,workspace_title,last_seen,created_at FROM bot_devices WHERE id=? AND tenant_id=? AND user_id=? AND active=1",vec![json!(key),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)
}
pub async fn bind_task(
    state: &AppState,
    tx: &mut Transaction<'_, Any>,
    actor: &Actor,
    key: &str,
    device: &str,
) -> Result<()> {
    // Admission and revoke serialize on the same device row. Routing exists before the task is visible.
    if state.db.tx_exec(tx,"UPDATE bot_devices SET active=active WHERE id=? AND tenant_id=? AND user_id=? AND active=1",vec![json!(device),json!(actor.tenant_id),json!(actor.id)]).await?==0 {return Err(AppError::missing());}
    state
        .db
        .tx_exec(
            tx,
            "INSERT INTO bot_local_execution(task_id,device_id,origin) VALUES(?,?,'web')",
            vec![json!(key), json!(device)],
        )
        .await?;
    Ok(())
}
pub async fn devices(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let mut rows=state.db.rows("SELECT id,name,workspace_id,workspace_title,last_seen,created_at FROM bot_devices WHERE tenant_id=? AND user_id=? AND active=1 ORDER BY created_at",vec![json!(actor.tenant_id),json!(actor.id)]).await?;
    for row in &mut rows {
        row.insert("online".into(), json!(n(row, "last_seen") > now() - 45000));
    }
    Ok(Json(json!(rows)))
}
pub async fn revoke(
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
            "UPDATE bot_devices SET active=0 WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        == 0
    {
        return Err(AppError::missing());
    }
    state.db.tx_exec(&mut tx,"UPDATE bot_tasks SET status='cancelled',worker_token=NULL,error='本地设备连接已解除',updated_at=? WHERE id IN (SELECT task_id FROM bot_local_execution WHERE device_id=?) AND status IN ('queued','running','waiting')",vec![json!(now()),json!(key)]).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn pairing(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let code = auth::token();
    let expires = now() + 600000;
    state
        .db
        .exec(
            "DELETE FROM bot_pairings WHERE expires_at<?",
            vec![json!(now())],
        )
        .await?;
    state
        .db
        .exec(
            "INSERT INTO bot_pairings(code_hash,tenant_id,user_id,expires_at) VALUES(?,?,?,?)",
            vec![
                json!(auth::hash(&code)),
                json!(actor.tenant_id),
                json!(actor.id),
                json!(expires),
            ],
        )
        .await?;
    Ok(Json(
        json!({"code":code,"expires_at":expires,"server_url":state.config.public_url}),
    ))
}
pub async fn disconnect(State(state): State<AppState>, device: Device) -> Result<Json<Value>> {
    revoke(State(state), device.actor, Path(device.id)).await
}
#[derive(Deserialize)]
pub struct Pair {
    code: String,
    token: String,
    name: String,
    workspace_id: String,
    workspace_title: String,
}
pub async fn pair(State(state): State<AppState>, Json(input): Json<Pair>) -> Result<Json<Value>> {
    if input.code.len() != 64
        || input.token.len() != 67
        || !input.token.starts_with("zd_")
        || !input.token[3..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AppError::bad("配对码或设备凭据无效"));
    }
    valid_text(&input.name, 80)?;
    valid_text(&input.workspace_id, 200)?;
    valid_text(&input.workspace_title, 120)?;
    let code_hash = auth::hash(&input.code);
    let token_hash = auth::hash(&input.token);
    let mut tx = state.db.pool.begin().await?;
    // Row locking works identically with PostgreSQL and SQLite; the code is single use.
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_pairings SET expires_at=expires_at WHERE code_hash=? AND expires_at>?",
            vec![json!(code_hash), json!(now())],
        )
        .await?
        == 0
    {
        return Err(AppError::bad("配对码已失效，请在网页重新生成"));
    }
    let pairing = state
        .db
        .tx_one(
            &mut tx,
            "SELECT * FROM bot_pairings WHERE code_hash=?",
            vec![json!(code_hash)],
        )
        .await?
        .unwrap();
    if !s(&pairing, "device_id").is_empty() {
        let existing = state
            .db
            .tx_one(
                &mut tx,
                "SELECT id FROM bot_devices WHERE id=? AND token_hash=? AND active=1",
                vec![json!(s(&pairing, "device_id")), json!(token_hash)],
            )
            .await?
            .ok_or_else(|| conflict("配对码已经使用"))?;
        tx.commit().await?;
        return Ok(Json(json!({"id":s(&existing,"id")})));
    }
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE users SET active=active WHERE id=? AND tenant_id=? AND active=1",
            vec![
                json!(s(&pairing, "user_id")),
                json!(s(&pairing, "tenant_id")),
            ],
        )
        .await?
        == 0
    {
        return Err(AppError::forbidden());
    }
    let count=state.db.tx_one(&mut tx,"SELECT COUNT(*) AS total FROM bot_devices WHERE user_id=? AND tenant_id=? AND active=1",vec![json!(s(&pairing,"user_id")),json!(s(&pairing,"tenant_id"))]).await?.unwrap();
    if n(&count, "total") >= 8 {
        return Err(AppError::bad("最多连接 8 台本地设备，请先解除旧连接"));
    }
    let key = id();
    state.db.tx_exec(&mut tx,"INSERT INTO bot_devices(id,tenant_id,user_id,token_hash,name,workspace_id,workspace_title,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(s(&pairing,"tenant_id")),json!(s(&pairing,"user_id")),json!(token_hash),json!(input.name),json!(input.workspace_id),json!(input.workspace_title),json!(now()),json!(now())]).await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_pairings SET device_id=? WHERE code_hash=?",
            vec![json!(key), json!(code_hash)],
        )
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":key})))
}
async fn assigned(state: &AppState, device: &Device, key: &str) -> Result<Record> {
    state.db.one("SELECT t.*,e.origin,e.session_id,e.turn_key,e.last_seq,e.last_hash FROM bot_tasks t JOIN bot_local_execution e ON e.task_id=t.id WHERE t.id=? AND e.device_id=? AND t.user_id=? AND t.tenant_id=?",vec![json!(key),json!(device.id),json!(device.actor.id),json!(device.actor.tenant_id)]).await?.ok_or_else(AppError::missing)
}
pub async fn poll(State(state): State<AppState>, device: Device) -> Result<Json<Value>> {
    let mut tx = state.db.pool.begin().await?;
    fence(&state, &mut tx, &device).await?;
    tx.commit().await?;
    let rows=state.db.rows("SELECT t.id,t.prompt,t.title,t.options,t.status,e.origin,e.session_id,e.turn_key,e.last_seq FROM bot_tasks t JOIN bot_local_execution e ON e.task_id=t.id WHERE e.device_id=? AND (t.status IN ('queued','running','waiting') OR (t.status='cancelled' AND e.cancel_ack=0)) ORDER BY t.created_at LIMIT 100",vec![json!(device.id)]).await?;
    let mut commands = vec![];
    for row in rows {
        let options: bot::Options = serde_json::from_str(s(&row, "options")).unwrap_or_default();
        let parent = if let Some(key) = options.parent_task_id.as_ref() {
            state.db.one("SELECT e.session_id FROM bot_local_execution e JOIN bot_tasks t ON t.id=e.task_id WHERE e.task_id=? AND e.device_id=? AND t.status='completed' AND t.user_id=? AND t.tenant_id=?",vec![json!(key),json!(device.id),json!(device.actor.id),json!(device.actor.tenant_id)]).await?
        } else {
            None
        };
        let expected = parent
            .as_ref()
            .map(|r| s(r, "session_id").to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("session-zhixiaohui-{}", s(&row, "id")));
        commands.push(json!({"id":row["id"],"prompt":row["prompt"],"title":row["title"],"options":options,"status":row["status"],"origin":row["origin"],"session_id":row["session_id"],"expected_session_id":expected,"turn_key":row["turn_key"],"last_seq":row["last_seq"]}));
    }
    Ok(Json(json!({"commands":commands})))
}
#[derive(Deserialize)]
pub struct Start {
    session_id: String,
}
pub async fn start(
    State(state): State<AppState>,
    device: Device,
    Path(key): Path<String>,
    Json(input): Json<Start>,
) -> Result<Json<Value>> {
    valid_text(&input.session_id, 200)?;
    let row = assigned(&state, &device, &key).await?;
    if !s(&row, "session_id").is_empty() && s(&row, "session_id") != input.session_id {
        return Err(conflict("任务已绑定另一个桌面会话"));
    }
    let mut tx = state.db.pool.begin().await?;
    fence(&state, &mut tx, &device).await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_local_execution SET session_id=? WHERE task_id=? AND device_id=? AND (session_id IS NULL OR session_id=?)",vec![json!(input.session_id),json!(key),json!(device.id),json!(input.session_id)]).await?;
    let token = format!("local:{}", device.id);
    state.db.tx_exec(&mut tx,"UPDATE bot_tasks SET status='running',worker_token=?,attempt=CASE WHEN attempt=0 THEN 1 ELSE attempt END,updated_at=? WHERE id=? AND status IN ('queued','waiting')",vec![json!(token),json!(now()),json!(key)]).await?;
    let task = state
        .db
        .tx_one(
            &mut tx,
            "SELECT status FROM bot_tasks WHERE id=?",
            vec![json!(key)],
        )
        .await?
        .unwrap();
    if s(&task, "status") != "running" {
        return Err(conflict("任务已经取消或结束"));
    }
    tx.commit().await?;
    Ok(Json(json!({"accepted":true})))
}
#[derive(Deserialize)]
pub struct Import {
    session_id: String,
    turn_key: String,
    request_id: String,
    prompt: String,
    title: String,
}
pub async fn import(
    State(state): State<AppState>,
    device: Device,
    Json(input): Json<Import>,
) -> Result<Json<Value>> {
    valid_text(&input.session_id, 200)?;
    valid_text(&input.turn_key, 100)?;
    valid_text(&input.prompt, 6000)?;
    valid_text(&input.title, 100)?;
    if uuid::Uuid::parse_str(&input.request_id).is_err() {
        return Err(AppError::bad("本地任务标识无效"));
    }
    let mut tx = state.db.pool.begin().await?;
    fence(&state, &mut tx, &device).await?;
    if let Some(row)=state.db.tx_one(&mut tx,"SELECT task_id FROM bot_local_execution WHERE device_id=? AND session_id=? AND turn_key=?",vec![json!(device.id),json!(input.session_id),json!(input.turn_key)]).await? {
        tx.commit().await?; return Ok(Json(json!({"id":row["task_id"]})));
    }
    let parent=state.db.tx_one(&mut tx,"SELECT t.id FROM bot_tasks t JOIN bot_local_execution e ON e.task_id=t.id WHERE e.device_id=? AND e.session_id=? AND t.status='completed' ORDER BY t.created_at DESC LIMIT 1",vec![json!(device.id),json!(input.session_id)]).await?;
    let key = id();
    let options = bot::Options {
        local_device_id: Some(device.id.clone()),
        parent_task_id: parent.as_ref().map(|r| s(r, "id").to_owned()),
        ..Default::default()
    };
    state.db.tx_exec(&mut tx,"INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,worker_token,attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?,1,?,?)",vec![json!(key),json!(device.actor.tenant_id),json!(device.actor.id),json!(input.request_id),json!(input.prompt),json!(input.title),json!(serde_json::to_string(&options).unwrap()),json!(format!("local:{}",device.id)),json!(now()),json!(now())]).await?;
    state.db.tx_exec(&mut tx,"INSERT INTO bot_local_execution(task_id,device_id,origin,session_id,turn_key) VALUES(?,?,'desktop',?,?)",vec![json!(key),json!(device.id),json!(input.session_id),json!(input.turn_key)]).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":key})))
}
#[derive(Deserialize)]
pub struct Message {
    id: String,
    content: String,
    status: String,
    created_at: i64,
}
#[derive(Deserialize)]
pub struct PublicEvent {
    id: String,
    name: String,
    success: bool,
    created_at: i64,
}
#[derive(Deserialize)]
pub struct Sync {
    seq: i64,
    turn_key: String,
    status: String,
    result: String,
    #[serde(default)]
    messages: Vec<Message>,
    #[serde(default)]
    events: Vec<PublicEvent>,
    #[serde(default)]
    error: Option<String>,
}
pub async fn sync(
    State(state): State<AppState>,
    device: Device,
    Path(key): Path<String>,
    Json(input): Json<Sync>,
) -> Result<Json<Value>> {
    assigned(&state, &device, &key).await?;
    valid_text(&input.turn_key, 100)?;
    if input.seq <= 0
        || input.messages.len() > 200
        || input.events.len() > 300
        || input.result.len() > 100000
        || input.error.as_ref().is_some_and(|v| v.len() > 500)
        || ![
            "running",
            "waiting",
            "completed",
            "failed",
            "cancelled",
            "paused",
        ]
        .contains(&input.status.as_str())
    {
        return Err(AppError::bad("本地同步内容无效或过长"));
    }
    for m in &input.messages {
        if uuid::Uuid::parse_str(&m.id).is_err()
            || m.content.len() > 100000
            || !["streaming", "completed", "interrupted"].contains(&m.status.as_str())
        {
            return Err(AppError::bad("本地公开消息无效"));
        }
    }
    for e in &input.events {
        if uuid::Uuid::parse_str(&e.id).is_err() {
            return Err(AppError::bad("本地事件标识无效"));
        }
        valid_text(&e.name, 100)?;
    }
    // Hash the actual request, including order, to reject conflicting retries of a sequence.
    let hash=auth::hash(&json!({"turn":input.turn_key,"status":input.status,"result":input.result,"error":input.error,"messages":input.messages.iter().map(|m|json!([m.id,m.content,m.status,m.created_at])).collect::<Vec<_>>(),"events":input.events.iter().map(|e|json!([e.id,e.name,e.success,e.created_at])).collect::<Vec<_>>()}).to_string());
    let mut tx = state.db.pool.begin().await?;
    fence(&state, &mut tx, &device).await?;
    let row=state.db.tx_one(&mut tx,"SELECT t.status,e.last_seq,e.last_hash,e.turn_key FROM bot_tasks t JOIN bot_local_execution e ON e.task_id=t.id WHERE t.id=? AND e.device_id=?",vec![json!(key),json!(device.id)]).await?.ok_or_else(AppError::missing)?;
    if input.seq == n(&row, "last_seq") && hash == s(&row, "last_hash") {
        tx.commit().await?;
        return Ok(Json(json!({"ack":input.seq})));
    }
    if input.seq != n(&row, "last_seq") + 1 {
        return Err(conflict("同步序号不连续或同一序号内容冲突"));
    }
    if !["running", "waiting"].contains(&s(&row, "status")) {
        return Err(conflict("任务已经取消或结束，拒绝迟到的执行结果"));
    }
    if !s(&row, "turn_key").is_empty() && input.turn_key != s(&row, "turn_key") {
        return Err(conflict("同步轮次与任务不匹配"));
    }
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_local_execution SET turn_key=?,last_seq=?,last_hash=? WHERE task_id=?",
            vec![
                json!(input.turn_key),
                json!(input.seq),
                json!(hash),
                json!(key),
            ],
        )
        .await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "DELETE FROM bot_messages WHERE task_id=? AND status='streaming'",
            vec![json!(key)],
        )
        .await?;
    for m in input.messages {
        state.db.tx_exec(&mut tx,"INSERT INTO bot_messages(task_id,id,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET content=excluded.content,status=excluded.status,updated_at=excluded.updated_at",vec![json!(key),json!(m.id),json!(m.content),json!(m.status),json!(m.created_at),json!(now())]).await?;
    }
    for e in input.events {
        state.db.tx_exec(&mut tx,"INSERT INTO bot_events(id,task_id,kind,content,created_at) VALUES(?,?,'tool',?,?) ON CONFLICT(id) DO NOTHING",vec![json!(e.id),json!(key),json!(json!({"name":e.name,"success":e.success}).to_string()),json!(e.created_at)]).await?;
    }
    state.db.tx_exec(&mut tx,"UPDATE bot_tasks SET status=?,result=?,error=?,updated_at=? WHERE id=? AND status IN ('running','waiting')",vec![json!(input.status),json!(input.result),json!(input.error),json!(now()),json!(key)]).await?;
    tx.commit().await?;
    Ok(Json(json!({"ack":input.seq})))
}
pub async fn cancel_ack(
    State(state): State<AppState>,
    device: Device,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    let row = assigned(&state, &device, &key).await?;
    if s(&row, "status") != "cancelled" {
        return Err(conflict("任务没有取消指令"));
    }
    let mut tx = state.db.pool.begin().await?;
    fence(&state, &mut tx, &device).await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_local_execution SET cancel_ack=1 WHERE task_id=? AND device_id=?",
            vec![json!(key), json!(device.id)],
        )
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Tool {
    name: String,
    args: Value,
}
pub async fn tool(
    State(state): State<AppState>,
    device: Device,
    Path(key): Path<String>,
    Json(input): Json<Tool>,
) -> Result<Json<Value>> {
    let row = assigned(&state, &device, &key).await?;
    // Local filesystem/code uses Harness's own tools and permissions. Platform tools stay task-bound.
    if ![
        "knowledge_search",
        "knowledge_read",
        "knowledge_spaces",
        "write_artifact",
        "read_artifact",
        "task_plan",
    ]
    .contains(&input.name.as_str())
    {
        return Err(AppError::forbidden());
    }
    let context = bot::Context {
        task_id: key,
        token: format!("local:{}", device.id),
        options: serde_json::from_str(s(&row, "options")).unwrap_or_default(),
        connectors: vec![],
    };
    let snapshot = state.for_tenant(&device.actor.tenant_id).await?;
    Ok(Json(
        crate::agent::bridge_tool(
            &snapshot,
            &device.actor,
            context,
            &input.name,
            input.args,
            &row,
        )
        .await?,
    ))
}
