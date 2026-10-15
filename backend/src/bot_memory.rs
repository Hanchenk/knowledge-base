//! Personal, reviewed cross-task memory. Rust is the source of authority.
//! Core holds an idempotent curated L3 snapshot; raw task conversations are not exported.
use crate::{
    auth::{audit, hash, Actor},
    bot::{self, Context},
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    memory_provider, models, studio, AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

async fn settings(state: &AppState, actor: &Actor) -> Result<Record> {
    state.db.exec("INSERT INTO bot_memory_settings(tenant_id,user_id,updated_at) VALUES(?,?,?) ON CONFLICT(tenant_id,user_id) DO NOTHING",vec![json!(actor.tenant_id),json!(actor.id),json!(now())]).await?;
    state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE tenant_id=? AND user_id=?",
            vec![json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)
}
async fn owned(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    state.db.one("SELECT * FROM bot_memories WHERE id=? AND tenant_id=? AND user_id=? AND status!='deleted'",vec![json!(key),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)
}
async fn valid_source(state: &AppState, actor: &Actor, row: &Record) -> Result<bool> {
    let task = s(row, "source_task_id");
    if task.is_empty() {
        return Ok(true);
    }
    let Some(source) = state
        .db
        .one(
            "SELECT * FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(task), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
    else {
        return Ok(false);
    };
    if s(&source, "status") != "completed"
        || (!s(row, "source_hash").is_empty() && source_hash(&source) != s(row, "source_hash"))
    {
        return Ok(false);
    }
    let citations: Vec<Value> =
        serde_json::from_str(s(&source, "citations")).map_err(|_| AppError::bad("记忆来源无效"))?;
    if !valid_citations(state, actor, &citations).await? {
        return Ok(false);
    }
    Ok(validate_task_context(state, actor, task).await.is_ok())
}
fn source_hash(row: &Record) -> String {
    hash(&json!({"prompt":row["prompt"],"result":row["result"],"plan":row["plan"],"options":row["options"],"citations":row["citations"]}).to_string())
}
async fn valid_citations(state: &AppState, actor: &Actor, citations: &[Value]) -> Result<bool> {
    if !studio::valid_evidence(state, actor, citations).await? {
        return Ok(false);
    }
    for citation in citations {
        if state.db.one("SELECT id FROM documents WHERE id=? AND tenant_id=? AND space_id=? AND version=? AND deleted=0",vec![citation["document_id"].clone(),json!(actor.tenant_id),citation["space_id"].clone(),citation["version"].clone()]).await?.is_none() { return Ok(false); }
    }
    Ok(true)
}
fn content(state: &AppState, actor: &Actor, row: &Record) -> Result<String> {
    Ok(models::open::<String>(
        state,
        &actor.tenant_id,
        s(row, "encrypted_content"),
    )?)
}
fn public_settings(row: &Record) -> Value {
    json!({"enabled":n(row,"enabled")==1,"capture":n(row,"capture")==1,"skill_capture":n(row,"skill_capture")==1})
}

pub(crate) async fn ensure_skill_capture(state: &AppState, actor: &Actor) -> Result<()> {
    if n(&settings(state, actor).await?, "skill_capture") != 1 {
        return Err(AppError::bad(
            "个人设置已关闭技能提炼；已有候选仍可审核和清理",
        ));
    }
    Ok(())
}

pub(crate) async fn lock_skill_capture(
    state: &AppState,
    actor: &Actor,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
) -> Result<()> {
    // The row is created by the admission check. Serialize the final proposal
    // commit with preference changes without holding this lock during provider calls.
    state
        .db
        .tx_exec(
            tx,
            "UPDATE bot_memory_settings SET updated_at=? WHERE tenant_id=? AND user_id=?",
            vec![json!(now()), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    let row = state
        .db
        .tx_one(
            tx,
            "SELECT skill_capture FROM bot_memory_settings WHERE tenant_id=? AND user_id=?",
            vec![json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    if n(&row, "skill_capture") != 1 {
        return Err(AppError::bad(
            "个人设置已关闭技能提炼；已有候选仍可审核和清理",
        ));
    }
    Ok(())
}
async fn public(state: &AppState, actor: &Actor, row: &Record, settings: &Record) -> Result<Value> {
    // Pending task proposals may be previewed only while their source task is still readable.
    let usable = valid_source(state, actor, row).await?;
    let pending_visible = if s(row, "status") == "pending" && !s(row, "source_task_id").is_empty() {
        match state
            .db
            .one(
                "SELECT citations FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
                vec![
                    json!(s(row, "source_task_id")),
                    json!(actor.tenant_id),
                    json!(actor.id),
                ],
            )
            .await?
        {
            Some(source) => {
                studio::valid_evidence(
                    state,
                    actor,
                    serde_json::from_str::<Vec<Value>>(s(&source, "citations"))
                        .map_err(|_| AppError::bad("记忆来源无效"))?
                        .as_slice(),
                )
                .await?
            }
            None => false,
        }
    } else {
        false
    };
    let pending_visible = pending_visible
        && validate_task_context(state, actor, s(row, "source_task_id"))
            .await
            .is_ok();
    Ok(
        json!({"id":s(row,"id"),"content":if usable || pending_visible { content(state,actor,row)? } else { "来源任务或资料授权已变化，请删除此记忆".into() },"kind":s(row,"kind"),"status":s(row,"status"),"source_task_id":s(row,"source_task_id"),"source_available":usable,"created_at":n(row,"created_at"),"updated_at":n(row,"updated_at"),"provider_status":if !memory_provider::configured_core(state){"local"}else if n(settings,"synced_revision")<n(settings,"revision"){"pending"}else{"synced"}}),
    )
}
pub async fn list(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let settings = settings(&state, &actor).await?;
    let rows=state.db.rows("SELECT * FROM bot_memories WHERE tenant_id=? AND user_id=? AND status!='deleted' ORDER BY updated_at DESC,id LIMIT 100",vec![json!(actor.tenant_id),json!(actor.id)]).await?;
    let mut items = vec![];
    for row in rows {
        items.push(public(&state, &actor, &row, &settings).await?);
    }
    Ok(Json(
        json!({"items":items,"settings":public_settings(&settings),"provider":{"configured":memory_provider::configured_core(&state),"status":if n(&settings,"synced_revision")>=n(&settings,"revision"){"synced"}else{"pending"},"error":s(&settings,"sync_error")}}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryInput {
    pub content: String,
    #[serde(default = "preference")]
    pub kind: String,
}
fn preference() -> String {
    "preference".into()
}
fn validate(input: &MemoryInput) -> Result<()> {
    if input.content.trim().is_empty()
        || input.content.chars().count() > 2000
        || !["preference", "constraint", "experience"].contains(&input.kind.as_str())
    {
        return Err(AppError::bad(
            "记忆内容需为 1–2000 字，类型为偏好、约定或经验",
        ));
    }
    Ok(())
}
async fn insert(
    state: &AppState,
    actor: &Actor,
    input: MemoryInput,
    task: &str,
    pending: bool,
    token: Option<&str>,
) -> Result<String> {
    validate(&input)?;
    settings(state, actor).await?;
    let text = input.content.trim();
    // A deleted model proposal from the same task is a tombstone, not a new draft.
    let key = if pending {
        hash(&format!(
            "memory-proposal\n{}\n{}\n{task}\n{}\n{text}",
            actor.tenant_id, actor.id, input.kind
        ))
    } else {
        id()
    };
    let mut tx = state.db.pool.begin().await?;
    // Lock this user's settings row so limits/revisions are consistent across writers.
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_memory_settings SET updated_at=? WHERE tenant_id=? AND user_id=?",
            vec![json!(now()), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    if pending {
        if state.db.tx_one(&mut tx,"SELECT id FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=? AND status='running' AND worker_token=?",vec![json!(task),json!(actor.tenant_id),json!(actor.id),json!(token.unwrap_or(""))]).await?.is_none() { return Err(AppError::bad("任务已取消或执行租约已失效")); }
        let prefs = state
            .db
            .tx_one(
                &mut tx,
                "SELECT capture FROM bot_memory_settings WHERE tenant_id=? AND user_id=?",
                vec![json!(actor.tenant_id), json!(actor.id)],
            )
            .await?
            .unwrap();
        if n(&prefs, "capture") != 1 {
            return Err(AppError::bad("已关闭记忆提议"));
        }
        if state
            .db
            .tx_one(
                &mut tx,
                "SELECT id FROM bot_memories WHERE id=?",
                vec![json!(key)],
            )
            .await?
            .is_some()
        {
            tx.commit().await?;
            return Ok(key);
        }
    }
    let count=state.db.tx_one(&mut tx,"SELECT COUNT(*) AS total FROM bot_memories WHERE tenant_id=? AND user_id=? AND status!='deleted'",vec![json!(actor.tenant_id),json!(actor.id)]).await?.unwrap();
    if n(&count, "total") >= 100 {
        return Err(AppError::bad("最多保存 100 条个人记忆，请先整理旧记忆"));
    }
    let changed=state.db.tx_exec(&mut tx,"INSERT INTO bot_memories(id,tenant_id,user_id,kind,status,encrypted_content,source_task_id,content_hash,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ?='' OR EXISTS(SELECT id FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=? AND status='running' AND worker_token=?) ON CONFLICT(id) DO NOTHING",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(input.kind),json!(if pending{"pending"}else{"active"}),json!(models::seal(state,&actor.tenant_id,&text)?),json!(task),json!(hash(text)),json!(now()),json!(now()),json!(token.unwrap_or("")),json!(task),json!(actor.tenant_id),json!(actor.id),json!(token.unwrap_or(""))]).await?;
    if changed == 0 && pending {
        return Err(AppError::bad("任务已取消或记忆已提议"));
    }
    if changed > 0 && !pending {
        state.db.tx_exec(&mut tx,"UPDATE bot_memory_settings SET revision=revision+1,next_attempt_at=0,updated_at=? WHERE tenant_id=? AND user_id=?",vec![json!(now()),json!(actor.tenant_id),json!(actor.id)]).await?;
    }
    tx.commit().await?;
    Ok(key)
}
pub async fn create(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<MemoryInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let key = insert(&state, &actor, input, "", false, None).await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "bot.memory.create",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(json!({"id":key,"status":"active"})))
}
pub async fn update(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<MemoryInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    validate(&input)?;
    let row = owned(&state, &actor, &key).await?;
    if !s(&row, "source_task_id").is_empty() && !valid_source(&state, &actor, &row).await? {
        return Err(AppError::forbidden());
    }
    let mut tx = state.db.pool.begin().await?;
    let changed=state.db.tx_exec(&mut tx,"UPDATE bot_memories SET kind=?,encrypted_content=?,content_hash=?,updated_at=? WHERE id=? AND tenant_id=? AND user_id=? AND status=? AND updated_at=?",vec![json!(input.kind),json!(models::seal(&state,&actor.tenant_id,&input.content.trim())?),json!(hash(input.content.trim())),json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id),json!(s(&row,"status")),json!(n(&row,"updated_at"))]).await?;
    if changed == 0 {
        return Err(AppError::bad("记忆已变化，请刷新后重试"));
    }
    state.db.tx_exec(&mut tx,"UPDATE bot_memory_settings SET revision=revision+1,next_attempt_at=0,updated_at=? WHERE tenant_id=? AND user_id=?",vec![json!(now()),json!(actor.tenant_id),json!(actor.id)]).await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "bot.memory.update",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    decision: String,
}
pub async fn review(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<Review>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let row = owned(&state, &actor, &key).await?;
    if s(&row, "status") != "pending" || !["approve", "reject"].contains(&input.decision.as_str()) {
        return Err(AppError::bad("只能确认或拒绝待审核记忆"));
    }
    let approved = input.decision == "approve";
    if approved && !valid_source(&state, &actor, &row).await? {
        return Err(AppError::bad("来源任务需已完成且资料授权有效"));
    }
    let source = if approved {
        state
            .db
            .one(
                "SELECT * FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
                vec![
                    json!(s(&row, "source_task_id")),
                    json!(actor.tenant_id),
                    json!(actor.id),
                ],
            )
            .await?
    } else {
        None
    };
    let mut tx = state.db.pool.begin().await?;
    let changed=state.db.tx_exec(&mut tx,"UPDATE bot_memories SET status=?,encrypted_content=?,updated_at=? WHERE id=? AND tenant_id=? AND user_id=? AND status='pending' AND updated_at=?",vec![json!(if approved{"active"}else{"deleted"}),if approved{json!(s(&row,"encrypted_content"))}else{json!(models::seal(&state,&actor.tenant_id,&"")?)},json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id),json!(n(&row,"updated_at"))]).await?;
    if changed == 0 {
        return Err(AppError::bad("记忆已变化，请刷新后重试"));
    }
    if approved {
        if let Some(source) = source {
            state
                .db
                .tx_exec(
                    &mut tx,
                    "UPDATE bot_memories SET source_hash=?,source_citations=? WHERE id=?",
                    vec![
                        json!(source_hash(&source)),
                        source["citations"].clone(),
                        json!(key),
                    ],
                )
                .await?;
        }
        state.db.tx_exec(&mut tx,"UPDATE bot_memory_settings SET revision=revision+1,next_attempt_at=0,updated_at=? WHERE tenant_id=? AND user_id=?",vec![json!(now()),json!(actor.tenant_id),json!(actor.id)]).await?;
    }
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "bot.memory.review",
        Some(&key),
        json!({"decision":input.decision}),
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"status":if approved{"active"}else{"deleted"}}),
    ))
}
pub async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    owned(&state, &actor, &key).await?;
    let mut tx = state.db.pool.begin().await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_memories SET status='deleted',encrypted_content=?,content_hash='',source_hash='',source_citations='[]',updated_at=? WHERE id=? AND tenant_id=? AND user_id=?",vec![json!(models::seal(&state,&actor.tenant_id,&"")?),json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id)]).await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_memory_settings SET revision=revision+1,next_attempt_at=0,updated_at=? WHERE tenant_id=? AND user_id=?",vec![json!(now()),json!(actor.tenant_id),json!(actor.id)]).await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "bot.memory.delete",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"provider_cleanup_pending":memory_provider::configured_core(&state)}),
    ))
}
pub async fn forget(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    settings(&state, &actor).await?;
    let mut tx = state.db.pool.begin().await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_memory_settings SET capture=0,revision=revision+1,next_attempt_at=0,updated_at=? WHERE tenant_id=? AND user_id=?",vec![json!(now()),json!(actor.tenant_id),json!(actor.id)]).await?;
    state.db.tx_exec(&mut tx,"UPDATE bot_memories SET status='deleted',encrypted_content=?,content_hash='',source_hash='',source_citations='[]',updated_at=? WHERE tenant_id=? AND user_id=?",vec![json!(models::seal(&state,&actor.tenant_id,&"")?),json!(now()),json!(actor.tenant_id),json!(actor.id)]).await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "bot.memory.forget",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"capture":false,"provider_cleanup_pending":memory_provider::configured_core(&state)}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsInput {
    enabled: Option<bool>,
    capture: Option<bool>,
    skill_capture: Option<bool>,
}
pub async fn get_settings(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    Ok(Json(public_settings(&settings(&state, &actor).await?)))
}
pub async fn save_settings(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    settings(&state, &actor).await?;
    let mut assignments = Vec::new();
    let mut arguments = Vec::new();
    for (field, value) in [
        ("enabled", input.enabled),
        ("capture", input.capture),
        ("skill_capture", input.skill_capture),
    ] {
        if let Some(value) = value {
            assignments.push(format!("{field}=?"));
            arguments.push(json!(value));
        }
    }
    if !assignments.is_empty() {
        assignments.push("revision=revision+1,next_attempt_at=0,updated_at=?".into());
        arguments.extend([json!(now()), json!(actor.tenant_id), json!(actor.id)]);
        state
            .db
            .exec(
                &format!(
                    "UPDATE bot_memory_settings SET {} WHERE tenant_id=? AND user_id=?",
                    assignments.join(",")
                ),
                arguments,
            )
            .await?;
    }
    Ok(Json(public_settings(&settings(&state, &actor).await?)))
}
pub async fn tool_propose(
    state: &AppState,
    actor: &Actor,
    context: &Context,
    args: Value,
) -> Result<Value> {
    bot::ensure_running(state, actor, context).await?;
    let prefs = settings(state, actor).await?;
    if !context.options.memory_enabled || n(&prefs, "capture") != 1 {
        return Err(AppError::bad("本任务或个人设置已关闭记忆提议"));
    }
    let input: MemoryInput =
        serde_json::from_value(args).map_err(|_| AppError::bad("记忆提议参数无效"))?;
    let key = insert(
        state,
        actor,
        input,
        &context.task_id,
        true,
        Some(&context.token),
    )
    .await?;
    let row = state
        .db
        .one(
            "SELECT status FROM bot_memories WHERE id=?",
            vec![json!(key)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    Ok(
        json!({"id":key,"status":row["status"],"message":if s(&row,"status")=="deleted" {"此提议已被拒绝或删除，不会重新创建"} else {"已保存个人记忆提议；待审核内容确认前不会用于其他任务"}}),
    )
}
async fn active(state: &AppState, actor: &Actor) -> Result<Vec<Value>> {
    let rows=state.db.rows("SELECT * FROM bot_memories WHERE tenant_id=? AND user_id=? AND status='active' ORDER BY updated_at DESC,id LIMIT 100",vec![json!(actor.tenant_id),json!(actor.id)]).await?;
    let mut items = vec![];
    for row in rows {
        if valid_source(state, actor, &row).await? {
            items.push(json!({"id":s(&row,"id"),"kind":s(&row,"kind"),"content":content(state,actor,&row)?,"source_task_id":s(&row,"source_task_id"),"updated_at":n(&row,"updated_at")}));
        }
    }
    Ok(items)
}
fn relevance(query: &str, item: &Value) -> usize {
    let text = item["content"].as_str().unwrap_or("").to_lowercase();
    let query = query.to_lowercase();
    let mut score = 0;
    for word in query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
    {
        if text.contains(word) {
            score += 10;
        }
        for pair in word.chars().collect::<Vec<_>>().windows(2) {
            if text.contains(&pair.iter().collect::<String>()) {
                score += 1;
            }
        }
    }
    if ["preference", "constraint"].contains(&item["kind"].as_str().unwrap_or("")) {
        score += 2;
    }
    score
}
pub async fn search(state: &AppState, actor: &Actor, query: &str, limit: usize) -> Result<Value> {
    if state
        .db
        .one(
            "SELECT id FROM users WHERE id=? AND tenant_id=? AND active=1",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        .is_none()
    {
        return Err(AppError::forbidden());
    }
    let prefs = settings(state, actor).await?;
    if n(&prefs, "enabled") != 1 {
        return Ok(json!({"items":[],"enabled":false}));
    }
    if query.chars().count() > 2000 || !(1..=5).contains(&limit) {
        return Err(AppError::bad("记忆查询最多 2000 字、5 条结果"));
    }
    let mut items = active(state, actor).await?;
    let mut engine = "platform-keyword";
    // Read the real Core snapshot, but only admit matching locally approved current records.
    // This rejects stale writes, fabricated IDs and revoked sources even during a sync race.
    if memory_provider::configured_core(state)
        && n(&prefs, "synced_revision") == n(&prefs, "revision")
    {
        if let Ok(Ok(data)) = tokio::time::timeout(
            Duration::from_secs(2),
            memory_provider::post_core(state, actor, "/v3/core/read", json!({})),
        )
        .await
        {
            if let Some(remote) = data["content"]
                .as_str()
                .and_then(|c| serde_json::from_str::<Value>(c).ok())
            {
                if remote["revision"].as_i64() == Some(n(&prefs, "revision")) {
                    for item in &mut items {
                        if let Some(found) = remote["items"].as_array().and_then(|rows| {
                            rows.iter()
                                .find(|r| r["id"] == item["id"] && r["content"] == item["content"])
                        }) {
                            let _ = found;
                            engine = "tencentdb-curated";
                        }
                    }
                }
            }
        }
    }
    let fresh_prefs = settings(state, actor).await?;
    if n(&fresh_prefs, "enabled") != 1 {
        return Ok(json!({"items":[],"enabled":false}));
    }
    let fresh = active(state, actor).await?;
    items.retain(|item| {
        fresh.iter().any(|current| {
            current["id"] == item["id"]
                && current["content"] == item["content"]
                && current["updated_at"] == item["updated_at"]
        })
    });
    items.retain(|item| relevance(query, item) > 0);
    items.sort_by_key(|item| std::cmp::Reverse(relevance(query, item)));
    let mut count = 0;
    items = items
        .into_iter()
        .take(limit)
        .filter_map(|mut item| {
            let value = item["content"].as_str().unwrap_or("");
            let length = value.chars().count();
            if count + length > 4000 {
                return None;
            }
            count += length;
            item["score"] = json!(relevance(query, &item));
            Some(item)
        })
        .collect();
    Ok(json!({"items":items,"enabled":true,"engine":engine,"untrusted_history":true}))
}
pub async fn tool_search(
    state: &AppState,
    actor: &Actor,
    context: &Context,
    args: Value,
) -> Result<Value> {
    bot::ensure_running(state, actor, context).await?;
    if !context.options.memory_enabled {
        return Err(AppError::bad("本任务已关闭长期记忆"));
    }
    let query = args["query"]
        .as_str()
        .ok_or_else(|| AppError::bad("缺少记忆检索词"))?;
    let result = search(
        state,
        actor,
        query,
        args["limit"].as_u64().unwrap_or(5) as usize,
    )
    .await?;
    for item in result["items"].as_array().unwrap_or(&vec![]) {
        state.db.exec("INSERT INTO bot_context_receipts(task_id,kind,context_id,fingerprint) VALUES(?,'memory',?,?) ON CONFLICT(task_id,kind,context_id) DO NOTHING",vec![json!(context.task_id),item["id"].clone(),json!(hash(item["content"].as_str().unwrap_or("")))]).await?;
    }
    bot::ensure_running(state, actor, context).await?;
    Ok(result)
}

// Receipts bind cached transcripts and derived task reuse to live approved content.
// Traverse source tasks iteratively so chained memories cannot bypass revocation.
pub async fn validate_task_context(state: &AppState, actor: &Actor, task_id: &str) -> Result<()> {
    if state
        .db
        .one(
            "SELECT id FROM users WHERE id=? AND tenant_id=? AND active=1",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        .is_none()
    {
        return Err(AppError::forbidden());
    }
    let mut tasks = vec![task_id.to_owned()];
    let mut seen = HashSet::new();
    while let Some(key) = tasks.pop() {
        if !seen.insert(key.clone()) {
            continue;
        }
        if seen.len() > 200 {
            return Err(AppError::bad("记忆来源链过长"));
        }
        let task = state
            .db
            .one(
                "SELECT * FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
                vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
            )
            .await?
            .ok_or_else(AppError::missing)?;
        let options: bot::Options = serde_json::from_str(s(&task, "options"))
            .map_err(|_| AppError::bad("任务上下文无效"))?;
        for skill in &options.skill_ids {
            if !["research", "meeting", "analysis", "writing"].contains(&skill.as_str()) {
                if let Some(source) =
                    crate::bot_skill_review::skill_source_task(state, actor, skill).await?
                {
                    tasks.push(source);
                }
            }
        }
        crate::bot_knowledge::validate_selection(state, actor, &options.knowledge_asset_ids)
            .await?;
        let receipts = state
            .db
            .rows(
                "SELECT * FROM bot_context_receipts WHERE task_id=?",
                vec![json!(key)],
            )
            .await?;
        for receipt in receipts {
            if s(&receipt, "kind") == "memory" {
                let prefs = settings(state, actor).await?;
                if n(&prefs, "enabled") != 1 {
                    return Err(AppError::bad("个人记忆已停用，请新建任务"));
                }
                let row = owned(state, actor, s(&receipt, "context_id")).await?;
                if s(&row, "status") != "active"
                    || s(&row, "content_hash") != s(&receipt, "fingerprint")
                {
                    return Err(AppError::bad("任务使用的个人记忆已更新或删除，请新建任务"));
                }
                let source = s(&row, "source_task_id");
                if !source.is_empty() {
                    let task = state
                        .db
                        .one(
                            "SELECT * FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
                            vec![json!(source), json!(actor.tenant_id), json!(actor.id)],
                        )
                        .await?
                        .ok_or_else(AppError::missing)?;
                    let citations: Vec<Value> = serde_json::from_str(s(&task, "citations"))
                        .map_err(|_| AppError::bad("记忆来源无效"))?;
                    if s(&task, "status") != "completed"
                        || (!s(&row, "source_hash").is_empty()
                            && source_hash(&task) != s(&row, "source_hash"))
                        || !valid_citations(state, actor, &citations).await?
                    {
                        return Err(AppError::forbidden());
                    }
                    tasks.push(source.to_owned());
                }
            } else if s(&receipt, "kind") == "task" {
                let parent=state.db.one("SELECT status,result,citations FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",vec![receipt["context_id"].clone(),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)?;
                let citations: Vec<Value> = serde_json::from_str(s(&parent, "citations"))
                    .map_err(|_| AppError::bad("来源任务无效"))?;
                if s(&parent, "status") != "completed"
                    || hash(s(&parent, "result")) != s(&receipt, "fingerprint")
                    || !studio::valid_evidence(state, actor, &citations).await?
                {
                    return Err(AppError::forbidden());
                }
                tasks.push(s(&receipt, "context_id").to_owned());
            } else if s(&receipt, "kind") == "knowledge" {
                let row =
                    crate::bot_knowledge::owned(state, actor, s(&receipt, "context_id")).await?;
                if knowledge_fingerprint(&row) != s(&receipt, "fingerprint")
                    || s(&row, "status") != "ready"
                {
                    return Err(AppError::bad("任务使用的知识资产已变化，请新建任务"));
                }
                crate::bot_knowledge::validate_selection(state, actor, &[s(&row, "id").to_owned()])
                    .await?;
            }
        }
    }
    Ok(())
}
fn knowledge_fingerprint(row: &Record) -> String {
    hash(&format!(
        "{}\n{}\n{}",
        s(row, "provider_id"),
        s(row, "source_snapshot"),
        s(row, "metadata")
    ))
}
pub async fn record_knowledge(
    state: &AppState,
    actor: &Actor,
    context: &Context,
    asset_id: &str,
) -> Result<()> {
    let row = crate::bot_knowledge::owned(state, actor, asset_id).await?;
    state.db.exec("INSERT INTO bot_context_receipts(task_id,kind,context_id,fingerprint) VALUES(?,'knowledge',?,?) ON CONFLICT(task_id,kind,context_id) DO NOTHING",vec![json!(context.task_id),json!(asset_id),json!(knowledge_fingerprint(&row))]).await?;
    validate_task_context(state, actor, &context.task_id).await
}
pub async fn inherit_task_context(
    state: &AppState,
    actor: &Actor,
    parent: &str,
    task: &str,
) -> Result<()> {
    validate_task_context(state, actor, parent).await?;
    let row = state
        .db
        .one(
            "SELECT result FROM bot_tasks WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(parent), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    state.db.exec("INSERT INTO bot_context_receipts(task_id,kind,context_id,fingerprint) VALUES(?,'task',?,?) ON CONFLICT(task_id,kind,context_id) DO NOTHING",vec![json!(task),json!(parent),json!(hash(s(&row,"result")))]).await?;
    state.db.exec("INSERT INTO bot_context_receipts(task_id,kind,context_id,fingerprint) SELECT ?,kind,context_id,fingerprint FROM bot_context_receipts WHERE task_id=? ON CONFLICT(task_id,kind,context_id) DO NOTHING",vec![json!(task),json!(parent)]).await?;
    validate_task_context(state, actor, task).await
}

/// One leased, idempotent full-snapshot export. Revisions fence stale responses.
pub async fn tick(state: &AppState) -> Result<bool> {
    if !memory_provider::configured_core(state) {
        return Ok(false);
    }
    let Some(row)=state.db.one("SELECT m.*,u.department_id,u.role,u.active AS owner_active FROM bot_memory_settings m JOIN users u ON u.id=m.user_id AND u.tenant_id=m.tenant_id WHERE m.lease_until<? AND m.next_attempt_at<=? ORDER BY m.updated_at LIMIT 1",vec![json!(now()),json!(now())]).await? else { return Ok(false); };
    let token = id();
    let changed=state.db.exec("UPDATE bot_memory_settings SET sync_token=?,lease_until=? WHERE tenant_id=? AND user_id=? AND lease_until<?",vec![json!(token),json!(now()+120000),json!(s(&row,"tenant_id")),json!(s(&row,"user_id")),json!(now())]).await?;
    if changed == 0 {
        return Ok(true);
    }
    let actor = Actor {
        id: s(&row, "user_id").into(),
        tenant_id: s(&row, "tenant_id").into(),
        department_id: s(&row, "department_id").into(),
        role: s(&row, "role").into(),
        scopes: None,
        key_id: None,
    };
    let revision = n(&row, "revision");
    let result = async {
        let items = if n(&row, "enabled") == 1 && n(&row, "owner_active") == 1 {
            active(state, &actor).await?
        } else {
            vec![]
        };
        let snapshot = json!({"version":1,"revision":revision,"items":items});
        let fingerprint = hash(&snapshot.to_string());
        if n(&row, "synced_revision") == revision && s(&row, "synced_fingerprint") == fingerprint {
            // Reconcile provider state too: a timed-out older write may commit late.
            let remote =
                memory_provider::post_core(state, &actor, "/v3/core/read", json!({})).await?;
            if remote["content"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .as_ref()
                == Some(&snapshot)
            {
                state.db.exec("UPDATE bot_memory_settings SET sync_token='',lease_until=0,next_attempt_at=? WHERE tenant_id=? AND user_id=? AND sync_token=?",vec![json!(now()+60000),json!(actor.tenant_id),json!(actor.id),json!(token)]).await?;
                return Ok(());
            }
        }
        // core/write is an upsert. scenario/write cannot create new files in this upstream version.
        memory_provider::post_core(
            state,
            &actor,
            "/v3/core/write",
            json!({"content":snapshot.to_string()}),
        )
        .await?;
        state.db.exec("UPDATE bot_memory_settings SET synced_fingerprint=? WHERE tenant_id=? AND user_id=? AND sync_token=? AND revision=?",vec![json!(fingerprint),json!(actor.tenant_id),json!(actor.id),json!(token),json!(revision)]).await?;
        Ok::<(), AppError>(())
    };
    tokio::pin!(result);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let result = loop {
        tokio::select! {
            output=&mut result=>break output,
            _=heartbeat.tick()=> {
                if state.db.exec("UPDATE bot_memory_settings SET lease_until=? WHERE tenant_id=? AND user_id=? AND sync_token=?",vec![json!(now()+120000),json!(actor.tenant_id),json!(actor.id),json!(token)]).await?==0 { return Ok(true); }
            }
        }
    };
    match result {
        Ok(()) => {
            state.db.exec("UPDATE bot_memory_settings SET synced_revision=?,sync_token='',lease_until=0,sync_error='',next_attempt_at=? WHERE tenant_id=? AND user_id=? AND sync_token=? AND revision=?",vec![json!(revision),json!(now()+60000),json!(actor.tenant_id),json!(actor.id),json!(token),json!(revision)]).await?;
            // A concurrent edit still needs a new export; release its obsolete lease.
            state.db.exec("UPDATE bot_memory_settings SET sync_token='',lease_until=0 WHERE tenant_id=? AND user_id=? AND sync_token=?",vec![json!(actor.tenant_id),json!(actor.id),json!(token)]).await?;
        }
        Err(error) => {
            state.db.exec("UPDATE bot_memory_settings SET sync_token='',lease_until=0,sync_error=?,next_attempt_at=? WHERE tenant_id=? AND user_id=? AND sync_token=?",vec![json!(error.1),json!(now()+30000),json!(actor.tenant_id),json!(actor.id),json!(token)]).await?;
        }
    }
    Ok(true)
}
pub async fn worker(state: AppState) {
    let memory = async {
        loop {
            if let Err(error) = tick(&state).await {
                tracing::warn!(error=%error.1,"personal memory sync failed");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };
    let skills = async {
        loop {
            if let Err(error) = crate::bot_skill_review::cleanup_tick(&state).await {
                tracing::warn!(error=%error.1,"skill cleanup failed");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };
    let knowledge = async {
        loop {
            if let Err(error) = crate::bot_knowledge::tick(&state).await {
                tracing::warn!(error=%error.1,"knowledge asset sync failed");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };
    tokio::join!(memory, skills, knowledge);
}
