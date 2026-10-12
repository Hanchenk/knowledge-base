use crate::{
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    AppState,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, State},
    http::{request::Parts, StatusCode},
    Json,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct Actor {
    pub id: String,
    pub tenant_id: String,
    pub department_id: String,
    pub role: String,
    pub scopes: Option<Vec<String>>,
    pub key_id: Option<String>,
}
impl Actor {
    pub fn admin(&self) -> Result<()> {
        if self.role == "admin" && self.scopes.is_none() {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }
    pub fn browser(&self) -> Result<()> {
        if self.scopes.is_none() {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }
    pub fn scope(&self, scope: &str) -> Result<()> {
        if self
            .scopes
            .as_ref()
            .is_none_or(|v| v.iter().any(|s| s == scope))
        {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }
}
impl FromRequestParts<AppState> for Actor {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let mut scopes = None;
        let mut key_id = None;
        let user = if let Some(header) = parts.headers.get("authorization") {
            let token = header.to_str().ok().and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(AppError::unauthorized)?;
            let key = state.db.one("SELECT * FROM api_keys WHERE secret_hash=? AND revoked=0 AND expires_at>?", vec![json!(hash(token)),json!(now())]).await?.ok_or_else(AppError::unauthorized)?;
            scopes = Some(serde_json::from_str::<Vec<String>>(s(&key,"scopes")).map_err(|_| AppError::unauthorized())?);
            key_id = Some(s(&key,"id").to_owned());
            state.db.exec("UPDATE api_keys SET last_used_at=? WHERE id=?",vec![json!(now()),json!(s(&key,"id"))]).await?;
            state.db.one("SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",vec![json!(s(&key,"user_id")),json!(s(&key,"tenant_id"))]).await?
        } else {
            let jar = CookieJar::from_headers(&parts.headers);
            let token = jar.get("atlas_session").ok_or_else(AppError::unauthorized)?.value();
            state.db.one("SELECT u.* FROM users u JOIN sessions ss ON ss.user_id=u.id WHERE ss.id=? AND ss.expires_at>? AND u.active=1",vec![json!(hash(token)),json!(now())]).await?
        }.ok_or_else(AppError::unauthorized)?;
        Ok(Self {
            id: s(&user, "id").into(),
            tenant_id: s(&user, "tenant_id").into(),
            department_id: s(&user, "department_id").into(),
            role: s(&user, "role").into(),
            scopes,
            key_id,
        })
    }
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn password_hash(password: &str) -> anyhow::Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|s| s.to_string())
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}
pub fn password_valid(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).ok().is_some_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok()
    })
}
pub fn validate_password(password: &str) -> Result<()> {
    if password.is_empty() || password.chars().count() > 128 {
        Err(AppError::bad("密码不能为空且不能超过 128 字符"))
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct Login {
    pub tenant: String,
    pub email: String,
    pub password: String,
}
pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(input): Json<Login>,
) -> Result<(CookieJar, Json<Value>)> {
    if input.password.chars().count() > 128 || input.email.len() > 254 {
        return Err(AppError::unauthorized());
    }
    let fingerprint = hash(&format!(
        "{}:{}",
        input.tenant,
        input.email.trim().to_lowercase()
    ));
    let attempts = state
        .db
        .one(
            "SELECT COUNT(*) AS count FROM login_attempts WHERE fingerprint=? AND created_at>?",
            vec![json!(fingerprint), json!(now() - 900_000)],
        )
        .await?
        .unwrap();
    if n(&attempts, "count") >= 10 {
        return Err(AppError(
            StatusCode::TOO_MANY_REQUESTS,
            "登录尝试过于频繁，请 15 分钟后重试".into(),
        ));
    }
    state
        .db
        .exec(
            "INSERT INTO login_attempts(id,fingerprint,created_at) VALUES(?,?,?)",
            vec![json!(id()), json!(fingerprint), json!(now())],
        )
        .await?;
    let user=state.db.one("SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.slug=? AND u.email=? AND u.active=1",vec![json!(input.tenant),json!(input.email.trim().to_lowercase())]).await?;
    let dummy = state.dummy_password.clone();
    let password = input.password;
    let saved = user
        .as_ref()
        .map(|u| s(u, "password_hash").to_owned())
        .unwrap_or(dummy);
    let valid = tokio::task::spawn_blocking(move || password_valid(&password, &saved))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    if !valid || user.is_none() {
        return Err(AppError::unauthorized());
    }
    let user = user.unwrap();
    state
        .db
        .exec(
            "DELETE FROM login_attempts WHERE fingerprint=?",
            vec![json!(fingerprint)],
        )
        .await?;
    let jar = issue_session(&state, jar, s(&user, "id")).await?;
    audit(
        &state,
        s(&user, "tenant_id"),
        s(&user, "id"),
        "auth.login",
        None,
        json!({"method":"password"}),
    )
    .await?;
    Ok((jar, Json(public_user(&user))))
}
pub async fn issue_session(
    state: &AppState,
    jar: CookieJar,
    user_id: &str,
) -> anyhow::Result<CookieJar> {
    let secret = token();
    state
        .db
        .exec(
            "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
            vec![
                json!(hash(&secret)),
                json!(user_id),
                json!(now() + 43_200_000),
            ],
        )
        .await?;
    let cookie = Cookie::build(("atlas_session", secret))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.production && !state.config.allow_insecure_http)
        .max_age(time::Duration::hours(12))
        .build();
    Ok(jar.add(cookie))
}
pub async fn logout(
    State(state): State<AppState>,
    actor: Actor,
    jar: CookieJar,
) -> Result<(CookieJar, Json<Value>)> {
    actor.browser()?;
    if let Some(cookie) = jar.get("atlas_session") {
        state
            .db
            .exec(
                "DELETE FROM sessions WHERE id=?",
                vec![json!(hash(cookie.value()))],
            )
            .await?;
    }
    Ok((
        jar.remove(Cookie::build("atlas_session").path("/").build()),
        Json(json!({"ok":true})),
    ))
}
pub fn public_user(row: &Record) -> Value {
    json!({"id":s(row,"id"),"tenant_id":s(row,"tenant_id"),"department_id":row.get("department_id"),"manager_id":row.get("manager_id"),"name":s(row,"name"),"email":s(row,"email"),"role":s(row,"role"),"active":n(row,"active")==1})
}
pub async fn me(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    let user = state
        .db
        .one("SELECT * FROM users WHERE id=?", vec![json!(actor.id)])
        .await?
        .ok_or_else(AppError::missing)?;
    let tenant = state
        .db
        .one(
            "SELECT * FROM tenants WHERE id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    Ok(Json(json!({"user":public_user(&user),"tenant":tenant})))
}
pub async fn audit(
    state: &AppState,
    tenant: &str,
    user: &str,
    action: &str,
    resource: Option<&str>,
    details: Value,
) -> anyhow::Result<()> {
    state.db.exec("INSERT INTO audit_events(id,tenant_id,user_id,action,resource_id,details,created_at) VALUES(?,?,?,?,?,?,?)",vec![json!(id()),json!(tenant),json!(user),json!(action),json!(resource),json!(details.to_string()),json!(now())]).await?;
    Ok(())
}
