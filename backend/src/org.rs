use crate::{
    acl,
    auth::{audit, password_hash, public_user, validate_password, Actor},
    db::{id, now, s},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn label(value: &str, max: usize) -> Result<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > max {
        Err(AppError::bad(format!("名称不能为空且不能超过 {max} 字符")))
    } else {
        Ok(text.into())
    }
}
async fn department(state: &AppState, tenant: &str, id: &Option<String>) -> Result<()> {
    if let Some(id) = id {
        if state
            .db
            .one(
                "SELECT id FROM departments WHERE id=? AND tenant_id=?",
                vec![json!(id), json!(tenant)],
            )
            .await?
            .is_none()
        {
            return Err(AppError::bad("部门不存在"));
        }
    }
    Ok(())
}
async fn manager(state: &AppState, tenant: &str, id: &Option<String>) -> Result<()> {
    if let Some(id) = id {
        if state
            .db
            .one(
                "SELECT id FROM users WHERE id=? AND tenant_id=? AND active=1",
                vec![json!(id), json!(tenant)],
            )
            .await?
            .is_none()
        {
            return Err(AppError::bad("上级不存在或已停用"));
        }
    }
    Ok(())
}
fn email(value: &str) -> Result<String> {
    let value = value.trim().to_lowercase();
    if value.len() > 254 || !value.contains('@') || value.contains(' ') {
        Err(AppError::bad("邮箱格式不正确"))
    } else {
        Ok(value)
    }
}
pub async fn organization(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    // Organization data is needed for ACL selection; only admins can inspect all personnel.
    actor.admin()?;
    let departments = state
        .db
        .rows(
            "SELECT * FROM departments WHERE tenant_id=? ORDER BY name",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let users = state
        .db
        .rows(
            "SELECT * FROM users WHERE tenant_id=? ORDER BY created_at",
            vec![json!(actor.tenant_id)],
        )
        .await?
        .iter()
        .map(public_user)
        .collect::<Vec<_>>();
    Ok(Json(json!({"departments":departments,"users":users})))
}
#[derive(Deserialize)]
pub struct DepartmentInput {
    pub name: String,
    pub parent_id: Option<String>,
}
pub async fn create_department(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<DepartmentInput>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let name = label(&input.name, 100)?;
    department(&state, &actor.tenant_id, &input.parent_id).await?;
    let key = id();
    state
        .db
        .exec(
            "INSERT INTO departments(id,tenant_id,name,parent_id) VALUES(?,?,?,?)",
            vec![
                json!(key),
                json!(actor.tenant_id),
                json!(name),
                json!(input.parent_id),
            ],
        )
        .await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "department.create",
        Some(&key),
        json!({"name":name}),
    )
    .await?;
    Ok(Json(
        json!({"id":key,"name":name,"parent_id":input.parent_id}),
    ))
}
pub async fn update_department(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<DepartmentInput>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let name = label(&input.name, 100)?;
    let mut tx = state.db.pool.begin().await?;
    // Serialize hierarchy edits per tenant to prevent concurrent cycle creation.
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE tenants SET name=name WHERE id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let departments = state
        .db
        .rows(
            "SELECT id,parent_id FROM departments WHERE tenant_id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    if !departments.iter().any(|r| s(r, "id") == key) {
        return Err(AppError::missing());
    }
    let parents: HashMap<_, _> = departments
        .iter()
        .map(|r| (s(r, "id").to_owned(), s(r, "parent_id").to_owned()))
        .collect();
    if let Some(parent) = &input.parent_id {
        if !parents.contains_key(parent) || acl::ancestors(parent, &parents).contains(&key) {
            return Err(AppError::bad("部门层级不能形成循环"));
        }
    }
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE departments SET name=?,parent_id=? WHERE id=? AND tenant_id=?",
            vec![
                json!(name),
                json!(input.parent_id),
                json!(key),
                json!(actor.tenant_id),
            ],
        )
        .await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "department.update",
        Some(&key),
        json!({"parent_id":input.parent_id}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct UserCreate {
    pub email: String,
    pub name: String,
    pub password: String,
    pub department_id: Option<String>,
    pub manager_id: Option<String>,
    #[serde(default = "member")]
    pub role: String,
}
fn member() -> String {
    "member".into()
}
fn role(value: &str) -> Result<()> {
    if ["admin", "member"].contains(&value) {
        Ok(())
    } else {
        Err(AppError::bad("角色必须是 admin 或 member"))
    }
}
pub async fn create_user(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<UserCreate>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let name = label(&input.name, 100)?;
    let email = email(&input.email)?;
    validate_password(&input.password)?;
    role(&input.role)?;
    department(&state, &actor.tenant_id, &input.department_id).await?;
    manager(&state, &actor.tenant_id, &input.manager_id).await?;
    if state
        .db
        .one(
            "SELECT id FROM users WHERE tenant_id=? AND email=?",
            vec![json!(actor.tenant_id), json!(email)],
        )
        .await?
        .is_some()
    {
        return Err(AppError::bad("该邮箱已存在"));
    }
    let saved = tokio::task::spawn_blocking(move || password_hash(&input.password))
        .await
        .map_err(|e| anyhow::anyhow!(e))??;
    let key = id();
    state.db.exec("INSERT INTO users(id,tenant_id,department_id,manager_id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?,?,1,?)",vec![json!(key),json!(actor.tenant_id),json!(input.department_id),json!(input.manager_id),json!(email),json!(name),json!(saved),json!(input.role),json!(now())]).await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "user.create",
        Some(&key),
        json!({"email":email,"role":input.role}),
    )
    .await?;
    Ok(Json(json!({"id":key})))
}
#[derive(Deserialize)]
pub struct UserUpdate {
    pub name: String,
    pub department_id: Option<String>,
    pub manager_id: Option<String>,
    pub role: String,
    pub active: bool,
    pub password: Option<String>,
}
pub async fn update_user(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<UserUpdate>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let name = label(&input.name, 100)?;
    role(&input.role)?;
    if key == actor.id && (input.role != "admin" || !input.active) {
        return Err(AppError::bad("不能停用自己或降低自己的管理员角色"));
    }
    let mut tx = state.db.pool.begin().await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE tenants SET name=name WHERE id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let current_admin = state
        .db
        .tx_one(
            &mut tx,
            "SELECT role,active FROM users WHERE id=? AND tenant_id=?",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        .ok_or_else(AppError::unauthorized)?;
    if s(&current_admin, "role") != "admin" || crate::db::n(&current_admin, "active") != 1 {
        return Err(AppError::forbidden());
    }
    let target = state
        .db
        .tx_one(
            &mut tx,
            "SELECT * FROM users WHERE id=? AND tenant_id=?",
            vec![json!(key), json!(actor.tenant_id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    department(&state, &actor.tenant_id, &input.department_id).await?;
    manager(&state, &actor.tenant_id, &input.manager_id).await?;
    let users = state
        .db
        .rows(
            "SELECT id,manager_id FROM users WHERE tenant_id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let parents: HashMap<_, _> = users
        .iter()
        .map(|r| (s(r, "id").to_owned(), s(r, "manager_id").to_owned()))
        .collect();
    if input
        .manager_id
        .as_ref()
        .is_some_and(|m| acl::ancestors(m, &parents).contains(&key))
    {
        return Err(AppError::bad("汇报关系不能形成循环"));
    }
    state.db.tx_exec(&mut tx,"UPDATE users SET name=?,department_id=?,manager_id=?,role=?,active=? WHERE id=? AND tenant_id=?",vec![json!(name),json!(input.department_id),json!(input.manager_id),json!(input.role),json!(input.active),json!(key),json!(actor.tenant_id)]).await?;
    if let Some(password) = input.password {
        validate_password(&password)?;
        let saved = tokio::task::spawn_blocking(move || password_hash(&password))
            .await
            .map_err(|e| anyhow::anyhow!(e))??;
        state
            .db
            .tx_exec(
                &mut tx,
                "UPDATE users SET password_hash=? WHERE id=?",
                vec![json!(saved), json!(key)],
            )
            .await?;
        state
            .db
            .tx_exec(
                &mut tx,
                "DELETE FROM sessions WHERE user_id=?",
                vec![json!(key)],
            )
            .await?;
    }
    if !input.active || input.role != s(&target, "role") {
        state
            .db
            .tx_exec(
                &mut tx,
                "DELETE FROM sessions WHERE user_id=?",
                vec![json!(key)],
            )
            .await?;
    }
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "user.update",
        Some(&key),
        json!({"role":input.role,"active":input.active}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn list_spaces(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    Ok(Json(spaces(&state, &actor).await?))
}
pub async fn spaces(state: &AppState, actor: &Actor) -> Result<Value> {
    actor.scope("search.read")?;
    let rights = acl::all_rights(state, actor).await?;
    let rows=state.db.rows("SELECT s.*,(SELECT COUNT(*) FROM documents d WHERE d.space_id=s.id AND d.deleted=0) AS document_count FROM spaces s WHERE s.tenant_id=? ORDER BY s.created_at",vec![json!(actor.tenant_id)]).await?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|mut row| {
            let permission = rights.get(s(&row, "id"))?;
            if !permission.can_view && !permission.can_create {
                return None;
            }
            if !permission.can_view {
                row.insert("document_count".into(), json!(0));
            }
            row.insert("permissions".into(), json!(permission));
            Some(row)
        })
        .collect::<Vec<_>>()))
}
#[derive(Deserialize)]
pub struct SpaceInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "blue")]
    pub color: String,
}
fn blue() -> String {
    "blue".into()
}
pub async fn create_space(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<SpaceInput>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let name = label(&input.name, 100)?;
    if !["blue", "purple", "green", "orange"].contains(&input.color.as_str()) {
        return Err(AppError::bad("空间颜色无效"));
    }
    if input.description.len() > 4000 {
        return Err(AppError::bad("描述过长"));
    }
    let key = id();
    state.db.exec("INSERT INTO spaces(id,tenant_id,name,description,color,created_by,created_at) VALUES(?,?,?,?,?,?,?)",vec![json!(key),json!(actor.tenant_id),json!(name),json!(input.description),json!(input.color),json!(actor.id),json!(now())]).await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "space.create",
        Some(&key),
        json!({"name":name}),
    )
    .await?;
    Ok(Json(json!({"id":key})))
}
pub async fn grants(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    acl::require(&state, &actor, &key, "manage").await?;
    Ok(Json(json!(
        state
            .db
            .rows("SELECT * FROM grants WHERE space_id=?", vec![json!(key)])
            .await?
    )))
}
#[derive(Deserialize)]
pub struct GrantInput {
    pub principal_type: String,
    pub principal_id: String,
    #[serde(default)]
    pub include_descendants: bool,
    #[serde(default)]
    pub can_view: bool,
    #[serde(default)]
    pub can_create: bool,
    #[serde(default)]
    pub can_manage: bool,
    #[serde(default = "allow")]
    pub effect: String,
}
fn allow() -> String {
    "allow".into()
}
pub async fn set_grants(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<Vec<GrantInput>>,
) -> Result<Json<Value>> {
    actor.browser()?;
    acl::require(&state, &actor, &key, "manage").await?;
    if state
        .db
        .one(
            "SELECT space_id FROM personal_spaces WHERE space_id=?",
            vec![json!(key)],
        )
        .await?
        .is_some()
    {
        return Err(AppError::bad("个人知识库仅本人可访问，不能修改共享权限"));
    }

    if input.len() > 200 {
        return Err(AppError::bad("每个知识空间最多 200 条授权规则"));
    }
    let mut unique = std::collections::HashSet::new();
    for grant in &input {
        if !["allow", "deny"].contains(&grant.effect.as_str())
            || !unique.insert((&grant.principal_type, &grant.principal_id))
        {
            return Err(AppError::bad("规则重复或授权类型无效"));
        }
        let exists = match grant.principal_type.as_str() {
            "tenant" => grant.principal_id == actor.tenant_id,
            "department" => state
                .db
                .one(
                    "SELECT id FROM departments WHERE id=? AND tenant_id=?",
                    vec![json!(grant.principal_id), json!(actor.tenant_id)],
                )
                .await?
                .is_some(),
            "user" | "reports" => state
                .db
                .one(
                    "SELECT id FROM users WHERE id=? AND tenant_id=?",
                    vec![json!(grant.principal_id), json!(actor.tenant_id)],
                )
                .await?
                .is_some(),
            _ => false,
        };
        if !exists {
            return Err(AppError::bad("授权对象无效或不属于当前企业"));
        }
        // Space managers may delegate only within their own space; role administration remains tenant-admin only.
    }
    let mut tx = state.db.pool.begin().await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE spaces SET name=name WHERE id=? AND tenant_id=?",
            vec![json!(key), json!(actor.tenant_id)],
        )
        .await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "DELETE FROM grants WHERE space_id=?",
            vec![json!(key)],
        )
        .await?;
    for grant in input {
        state.db.tx_exec(&mut tx,"INSERT INTO grants(id,space_id,principal_type,principal_id,include_descendants,can_view,can_create,can_manage,effect) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(id()),json!(key),json!(grant.principal_type),json!(grant.principal_id),json!(grant.include_descendants),json!(grant.can_view),json!(grant.can_create),json!(grant.can_manage),json!(grant.effect)]).await?;
    }
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "space.permissions.update",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct PrincipalsQuery {
    pub space_id: String,
}
pub async fn principals(
    State(state): State<AppState>,
    actor: Actor,
    axum::extract::Query(input): axum::extract::Query<PrincipalsQuery>,
) -> Result<Json<Value>> {
    actor.browser()?;
    acl::require(&state, &actor, &input.space_id, "manage").await?;
    let departments = state
        .db
        .rows(
            "SELECT id,name,parent_id FROM departments WHERE tenant_id=? ORDER BY name",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let users = state
        .db
        .rows(
            "SELECT id,name FROM users WHERE tenant_id=? AND active=1 ORDER BY name",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    Ok(Json(json!({"departments":departments,"users":users})))
}
