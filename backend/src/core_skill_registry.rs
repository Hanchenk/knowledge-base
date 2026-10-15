//! Native, private skill catalog identities. Credentials never leave this server.
use crate::{
    auth::{self, Actor},
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    memory_provider, models, AppState,
};
use axum::http::StatusCode;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const LEASE_MS: i64 = 120_000;

#[derive(Serialize, Deserialize)]
struct OwnerCredential {
    registry_id: String,
    provider_namespace: String,
    tenant_id: String,
    user_id: String,
    key: String,
}

pub fn namespace(state: &AppState) -> String {
    auth::hash(
        &json!([
            state.config.memory_core_url.trim_end_matches('/'),
            state.config.memory_service_id
        ])
        .to_string(),
    )
}
fn registry_id(state: &AppState, actor: &Actor) -> String {
    auth::hash(&json!([namespace(state), actor.tenant_id, actor.id]).to_string())
}
fn invalid() -> AppError {
    AppError(
        StatusCode::BAD_GATEWAY,
        "原生技能身份的归属或状态校验失败".into(),
    )
}
fn identity(row: &Record) -> Result<Value> {
    if n(row, "ready") != 1
        || ["native_user_id", "native_team_id", "native_agent_id"]
            .iter()
            .any(|key| s(row, key).is_empty())
    {
        return Err(invalid());
    }
    Ok(
        json!({"user_id":row["native_user_id"],"team_id":row["native_team_id"],"agent_id":row["native_agent_id"]}),
    )
}
fn credential(state: &AppState, actor: &Actor, row: &Record) -> Result<String> {
    let credential: OwnerCredential =
        models::open(state, s(row, "id"), s(row, "encrypted_owner_key"))?;
    if credential.registry_id != s(row, "id")
        || credential.provider_namespace != namespace(state)
        || credential.tenant_id != actor.tenant_id
        || credential.user_id != actor.id
    {
        return Err(invalid());
    }
    Ok(credential.key)
}
async fn read(state: &AppState, actor: &Actor) -> Result<Record> {
    state.db.one("SELECT * FROM core_skill_registry WHERE id=? AND tenant_id=? AND user_id=? AND provider_namespace=?",
        vec![json!(registry_id(state,actor)),json!(actor.tenant_id),json!(actor.id),json!(namespace(state))]).await?
        .ok_or_else(invalid)
}
async fn touch(state: &AppState, row: &Record, lease: &str) -> Result<()> {
    if state.db.exec("UPDATE core_skill_registry SET lease_until=?,updated_at=? WHERE id=? AND lease_token=?",
        vec![json!(now()+LEASE_MS),json!(now()),row["id"].clone(),json!(lease)]).await? != 1 {
        return Err(AppError(StatusCode::CONFLICT,"原生技能身份注册租约已失效，请重试".into()));
    }
    Ok(())
}
async fn save(
    state: &AppState,
    row: &mut Record,
    lease: &str,
    field: &str,
    value: Value,
) -> Result<()> {
    if !matches!(
        field,
        "native_user_id" | "native_team_id" | "native_agent_id" | "ready"
    ) {
        return Err(invalid());
    }
    if state.db.exec(&format!("UPDATE core_skill_registry SET {field}=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=?"),
        vec![value.clone(),json!(now()+LEASE_MS),json!(now()),row["id"].clone(),json!(lease)]).await? != 1 {return Err(invalid());}
    row.insert(field.into(), value);
    Ok(())
}
async fn meta(
    state: &AppState,
    row: &Record,
    lease: Option<&str>,
    key: Option<&str>,
    path: &str,
    body: Value,
) -> Result<Value> {
    if let Some(lease) = lease {
        touch(state, row, lease).await?;
    }
    let result = memory_provider::post_core_metadata(state, path, body, key).await;
    if let Some(lease) = lease {
        touch(state, row, lease).await?;
    }
    result
}
fn name(row: &Record) -> String {
    format!("zxh-skill-owner-{}", s(row, "id"))
}
fn marker(row: &Record) -> Value {
    json!({"integration":"zhixiaohui-skill-registry","registry_id":row["id"],"nonce":row["registration_nonce"]})
}
fn matches_marker(row: &Record, entity: &Value) -> bool {
    entity["metadata_json"]
        .as_str()
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        == Some(marker(row))
}
fn validate_user(row: &Record, user: &Value) -> Result<()> {
    if user["user_id"].as_str() != Some(s(row, "native_user_id"))
        || user["username"] != name(row)
        || user["user_type"] != "normal"
        || user["auth_provider"] != "zhixiaohui-skill-registry"
        || user["external_id"] != s(row, "id")
        || user["status"] != "active"
    {
        return Err(invalid());
    }
    Ok(())
}
fn validate_team(row: &Record, team: &Value) -> Result<()> {
    if team["team_id"].as_str().is_none_or(str::is_empty)
        || team["owner_user_id"].as_str() != Some(s(row, "native_user_id"))
        || team["name"] != name(row)
        || team["status"] != "active"
        || !matches_marker(row, team)
    {
        return Err(invalid());
    }
    if !s(row, "native_team_id").is_empty() && team["team_id"] != row["native_team_id"] {
        return Err(invalid());
    }
    Ok(())
}
fn validate_agent(row: &Record, agent: &Value) -> Result<()> {
    if agent["agent_id"].as_str().is_none_or(str::is_empty)
        || agent["owner_user_id"].as_str() != Some(s(row, "native_user_id"))
        || agent["team_id"].as_str() != Some(s(row, "native_team_id"))
        || agent["name"] != name(row)
        || agent["visibility"] != "private"
        || agent["status"] != "active"
        || !matches_marker(row, agent)
    {
        return Err(invalid());
    }
    if !s(row, "native_agent_id").is_empty() && agent["agent_id"] != row["native_agent_id"] {
        return Err(invalid());
    }
    Ok(())
}
async fn verify_user(state: &AppState, row: &Record, lease: Option<&str>) -> Result<()> {
    // Public user/get and auth/verify omit status; the trusted internal lookup includes it.
    let result = meta(
        state,
        row,
        lease,
        None,
        "/v3/internal/meta/user/list-by-instance",
        json!({"user_ids":[row["native_user_id"]],"limit":2,"offset":0}),
    )
    .await?;
    let users = result["items"].as_array().ok_or_else(invalid)?;
    if users.len() != 1 {
        return Err(invalid());
    }
    validate_user(row, &users[0])
}
async fn verify(state: &AppState, actor: &Actor, row: &Record) -> Result<()> {
    let key = credential(state, actor, row)?;
    let auth = meta(
        state,
        row,
        None,
        None,
        "/v3/meta/auth/verify",
        json!({"user_key":key}),
    )
    .await?;
    if auth["valid"] != true
        || auth["user"]["user_id"] != row["native_user_id"]
        || auth["user"]["username"] != name(row)
        || auth["user"]["user_type"] != "normal"
    {
        return Err(invalid());
    }
    verify_user(state, row, None).await?;
    let team = meta(
        state,
        row,
        None,
        Some(&key),
        "/v3/meta/team/get",
        json!({"team_id":row["native_team_id"]}),
    )
    .await?;
    validate_team(row, &team)?;
    let agent = meta(
        state,
        row,
        None,
        Some(&key),
        "/v3/meta/agent/get",
        json!({"agent_id":row["native_agent_id"]}),
    )
    .await?;
    validate_agent(row, &agent)
}
async fn find(
    state: &AppState,
    row: &Record,
    lease: &str,
    key: &str,
    path: &str,
    mut body: Value,
) -> Result<Vec<Value>> {
    let mut found = Vec::new();
    for offset in (0..1000).step_by(100) {
        body["limit"] = json!(100);
        body["offset"] = json!(offset);
        let response = meta(state, row, Some(lease), Some(key), path, body.clone()).await?;
        let items = response["items"].as_array().ok_or_else(invalid)?;
        found.extend(items.iter().filter(|v| v["name"] == name(row)).cloned());
        if items.len() < 100 {
            return Ok(found);
        }
    }
    Err(AppError(
        StatusCode::BAD_GATEWAY,
        "原生技能身份列表超过恢复上限".into(),
    ))
}
async fn register(state: &AppState, actor: &Actor, mut row: Record, lease: &str) -> Result<Value> {
    let key = credential(state, actor, &row)?;
    if s(&row, "native_user_id").is_empty() {
        let auth = meta(
            state,
            &row,
            Some(lease),
            None,
            "/v3/meta/auth/verify",
            json!({"user_key":key}),
        )
        .await?;
        let user = if auth["valid"] == true {
            auth["user"].clone()
        } else {
            // The key was committed before the network request. Its upstream UNIQUE
            // constraint makes a lost create response recoverable without minting keys.
            let created=meta(state,&row,Some(lease),Some(&state.config.memory_core_admin_user_key),"/v3/meta/user/create-with-key",
                json!({"username":name(&row),"user_key":key,"external_id":row["id"],"auth_provider":"zhixiaohui-skill-registry"})).await?;
            if created["user_type"] != "normal" || created["default_user_key"] != key {
                return Err(invalid());
            }
            created
        };
        let user_id = user["user_id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(invalid)?;
        if user["user_type"] != "normal"
            || (user.get("username").is_some() && user["username"] != name(&row))
        {
            return Err(invalid());
        }
        save(state, &mut row, lease, "native_user_id", json!(user_id)).await?;
    }
    verify_user(state, &row, Some(lease)).await?;
    if s(&row, "native_team_id").is_empty() {
        let teams = find(
            state,
            &row,
            lease,
            &key,
            "/v3/meta/team/list",
            json!({"user_id":row["native_user_id"],"name":name(&row)}),
        )
        .await?;
        if teams.len() > 1 {
            return Err(invalid());
        }
        let team = if let Some(team) = teams.first() {
            team.clone()
        } else {
            meta(state,&row,Some(lease),Some(&key),"/v3/meta/team/create",json!({"name":name(&row),"owner_user_id":row["native_user_id"],"status":"active","metadata_json":marker(&row).to_string()})).await?
        };
        validate_team(&row, &team)?;
        save(
            state,
            &mut row,
            lease,
            "native_team_id",
            team["team_id"].clone(),
        )
        .await?;
    } else {
        let team = meta(
            state,
            &row,
            Some(lease),
            Some(&key),
            "/v3/meta/team/get",
            json!({"team_id":row["native_team_id"]}),
        )
        .await?;
        validate_team(&row, &team)?;
    }
    if s(&row, "native_agent_id").is_empty() {
        let agents=find(state,&row,lease,&key,"/v3/meta/agent/list",json!({"team_id":row["native_team_id"],"owner_user_id":row["native_user_id"],"name":name(&row)})).await?;
        if agents.len() > 1 {
            return Err(invalid());
        }
        let agent = if let Some(agent) = agents.first() {
            agent.clone()
        } else {
            meta(state,&row,Some(lease),Some(&key),"/v3/meta/agent/create",json!({"team_id":row["native_team_id"],"name":name(&row),"owner_user_id":row["native_user_id"],"status":"active","visibility":"private","metadata_json":marker(&row).to_string()})).await?
        };
        validate_agent(&row, &agent)?;
        save(
            state,
            &mut row,
            lease,
            "native_agent_id",
            agent["agent_id"].clone(),
        )
        .await?;
    } else {
        let agent = meta(
            state,
            &row,
            Some(lease),
            Some(&key),
            "/v3/meta/agent/get",
            json!({"agent_id":row["native_agent_id"]}),
        )
        .await?;
        validate_agent(&row, &agent)?;
    }
    save(state, &mut row, lease, "ready", json!(1)).await?;
    identity(&row)
}

pub async fn ensure(state: &AppState, actor: &Actor) -> Result<Value> {
    if state.config.memory_core_admin_user_key.is_empty() {
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "原生技能身份注册尚未配置，请设置 MEMORY_CORE_ADMIN_USER_KEY".into(),
        ));
    }
    if state
        .db
        .one(
            "SELECT id FROM users WHERE id=? AND tenant_id=?",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        .is_none()
    {
        return Err(invalid());
    }
    let registry = registry_id(state, actor);
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let key = bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
    let encrypted = models::seal(
        state,
        &registry,
        &OwnerCredential {
            registry_id: registry.clone(),
            provider_namespace: namespace(state),
            tenant_id: actor.tenant_id.clone(),
            user_id: actor.id.clone(),
            key,
        },
    )?;
    state.db.exec("INSERT INTO core_skill_registry(id,tenant_id,user_id,provider_namespace,registration_nonce,encrypted_owner_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,provider_namespace) DO NOTHING",
        vec![json!(registry),json!(actor.tenant_id),json!(actor.id),json!(namespace(state)),json!(id()),json!(encrypted),json!(now()),json!(now())]).await?;
    let lease = id();
    for _ in 0..300 {
        let row = read(state, actor).await?;
        if n(&row, "ready") == 1 {
            verify(state, actor, &row).await?;
            return identity(&row);
        }
        if state.db.exec("UPDATE core_skill_registry SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND lease_until<=?",
            vec![json!(lease),json!(now()+LEASE_MS),json!(now()),json!(registry),json!(now())]).await?==1 {
            let result=register(state,actor,read(state,actor).await?,&lease).await;
            state.db.exec("UPDATE core_skill_registry SET lease_token='',lease_until=0,updated_at=? WHERE id=? AND lease_token=?",vec![json!(now()),json!(registry),json!(lease)]).await?;
            return result;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(AppError(
        StatusCode::CONFLICT,
        "原生技能身份正在注册，请稍后重试".into(),
    ))
}

pub async fn bind_receipt(state: &AppState, actor: &Actor, candidate_id: &str) -> Result<()> {
    let row = read(state, actor).await?;
    identity(&row)?;
    state.db.exec("INSERT INTO bot_skill_provider_receipts(id,registry_id,provider_namespace) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
        vec![json!(candidate_id),row["id"].clone(),json!(namespace(state))]).await?;
    receipt_identity(state, actor, candidate_id).await?;
    Ok(())
}
pub async fn receipt_identity(
    state: &AppState,
    actor: &Actor,
    candidate_id: &str,
) -> Result<Value> {
    let row=state.db.one("SELECT r.* FROM bot_skill_provider_receipts p JOIN core_skill_registry r ON r.id=p.registry_id WHERE p.id=? AND p.provider_namespace=? AND r.provider_namespace=? AND r.tenant_id=? AND r.user_id=?",
        vec![json!(candidate_id),json!(namespace(state)),json!(namespace(state)),json!(actor.tenant_id),json!(actor.id)]).await?
        .ok_or_else(||AppError(StatusCode::CONFLICT,"技能提炼回执不属于当前记忆服务，请重新提炼".into()))?;
    credential(state, actor, &row)?;
    identity(&row)
}

pub async fn copy_receipt(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    actor: &Actor,
    source_id: &str,
    candidate_id: &str,
) -> Result<()> {
    receipt_identity(state, actor, source_id).await?;
    if state.db.tx_exec(tx,"INSERT INTO bot_skill_provider_receipts(id,registry_id,provider_namespace,source_task_id,session_id,extraction_state,upstream_task_id,submitted_at) SELECT ?,registry_id,provider_namespace,source_task_id,session_id,extraction_state,upstream_task_id,submitted_at FROM bot_skill_provider_receipts WHERE id=? AND extraction_state='acknowledged' AND upstream_task_id<>'' ON CONFLICT(id) DO NOTHING",
        vec![json!(candidate_id),json!(source_id)]).await? != 1 {
        return Err(invalid());
    }
    Ok(())
}
