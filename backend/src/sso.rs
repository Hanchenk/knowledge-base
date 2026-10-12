use crate::{
    auth::{audit, hash, issue_session, token},
    db::{now, s},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Query, State},
    response::Redirect,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

async fn discovery(state: &AppState) -> Result<Value> {
    if !state.config.oidc() {
        return Err(AppError::bad("未配置企业 SSO"));
    }
    let response = state
        .http
        .get(&state.config.oidc_discovery_url)
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    if !response.status().is_success() {
        return Err(AppError::bad("SSO 服务暂不可用"));
    }
    let result: Value = response.json().await.map_err(anyhow::Error::from)?;
    for name in [
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
        "issuer",
    ] {
        let url = result[name]
            .as_str()
            .ok_or_else(|| AppError::bad("OIDC 服务配置不完整"))?;
        if state.config.production && !url.starts_with("https://") {
            return Err(AppError::bad("生产环境 OIDC 端点必须使用 HTTPS"));
        }
    }
    Ok(result)
}
pub async fn login(State(state): State<AppState>, jar: CookieJar) -> Result<(CookieJar, Redirect)> {
    let discovery = discovery(&state).await?;
    let secret = token();
    let verifier = token();
    let nonce = token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    state
        .db
        .exec(
            "INSERT INTO oidc_states(id,verifier,nonce,expires_at) VALUES(?,?,?,?)",
            vec![
                json!(hash(&secret)),
                json!(verifier),
                json!(nonce),
                json!(now() + 600_000),
            ],
        )
        .await?;
    let mut url = reqwest::Url::parse(discovery["authorization_endpoint"].as_str().unwrap())
        .map_err(anyhow::Error::from)?;
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &state.config.oidc_client_id),
        (
            "redirect_uri",
            &format!(
                "{}/api/auth/oidc/callback",
                state.config.public_url.trim_end_matches('/')
            ),
        ),
        ("scope", "openid email profile"),
        ("state", &secret),
        ("nonce", &nonce),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
    ]);
    let cookie = Cookie::build(("atlas_oidc_state", secret))
        .http_only(true)
        .secure(state.config.production && !state.config.allow_insecure_http)
        .same_site(SameSite::Lax)
        .path("/api/auth/oidc")
        .max_age(time::Duration::minutes(10))
        .build();
    Ok((jar.add(cookie), Redirect::to(url.as_str())))
}
#[derive(Deserialize)]
pub struct Callback {
    pub code: String,
    pub state: String,
}
#[derive(Deserialize)]
struct Claims {
    email: Option<String>,
    email_verified: Option<bool>,
    nonce: Option<String>,
}
pub async fn callback(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(input): Query<Callback>,
) -> Result<(CookieJar, Redirect)> {
    if jar
        .get("atlas_oidc_state")
        .is_none_or(|c| c.value() != input.state)
    {
        return Err(AppError::unauthorized());
    }
    let entry = state
        .db
        .one(
            "DELETE FROM oidc_states WHERE id=? AND expires_at>? RETURNING verifier,nonce",
            vec![json!(hash(&input.state)), json!(now())],
        )
        .await?
        .ok_or_else(AppError::unauthorized)?;
    let info = discovery(&state).await?;
    let callback = format!(
        "{}/api/auth/oidc/callback",
        state.config.public_url.trim_end_matches('/')
    );
    let response = state
        .http
        .post(info["token_endpoint"].as_str().unwrap())
        .basic_auth(
            &state.config.oidc_client_id,
            Some(&state.config.oidc_client_secret),
        )
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", input.code.as_str()),
            ("redirect_uri", callback.as_str()),
            ("code_verifier", s(&entry, "verifier")),
        ])
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    if !response.status().is_success() {
        return Err(AppError::unauthorized());
    }
    let payload: Value = response.json().await.map_err(anyhow::Error::from)?;
    let jwt = payload["id_token"]
        .as_str()
        .ok_or_else(AppError::unauthorized)?;
    let header = decode_header(jwt).map_err(|_| AppError::unauthorized())?;
    if header.alg != Algorithm::RS256 {
        return Err(AppError::bad("此 SSO 适配器要求 RS256 签名"));
    }
    let response = state
        .http
        .get(info["jwks_uri"].as_str().unwrap())
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    if !response.status().is_success() {
        return Err(AppError::unauthorized());
    }
    let jwks: Value = response.json().await.map_err(anyhow::Error::from)?;
    let key = jwks["keys"]
        .as_array()
        .and_then(|keys| {
            keys.iter().find(|k| {
                k["kid"].as_str() == header.kid.as_deref()
                    && k["kty"] == "RSA"
                    && k.get("use").is_none_or(|v| v == "sig")
            })
        })
        .ok_or_else(AppError::unauthorized)?;
    let decoding = DecodingKey::from_rsa_components(
        key["n"].as_str().ok_or_else(AppError::unauthorized)?,
        key["e"].as_str().ok_or_else(AppError::unauthorized)?,
    )
    .map_err(|_| AppError::unauthorized())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[&state.config.oidc_client_id]);
    validation.set_issuer(&[info["issuer"].as_str().unwrap()]);
    validation.validate_nbf = true;
    let claims = decode::<Claims>(jwt, &decoding, &validation)
        .map_err(|_| AppError::unauthorized())?
        .claims;
    if claims.nonce.as_deref() != Some(s(&entry, "nonce")) || claims.email_verified != Some(true) {
        return Err(AppError::unauthorized());
    }
    let email = claims
        .email
        .ok_or_else(AppError::unauthorized)?
        .to_lowercase();
    let user=state.db.one("SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.email=? AND u.active=1 AND t.slug=?",vec![json!(email),json!(state.config.oidc_tenant_slug)]).await?.ok_or_else(||AppError::bad("请先由企业管理员开通此账号"))?;
    let jar = issue_session(&state, jar, s(&user, "id")).await?.remove(
        Cookie::build("atlas_oidc_state")
            .path("/api/auth/oidc")
            .build(),
    );
    audit(
        &state,
        s(&user, "tenant_id"),
        s(&user, "id"),
        "auth.login",
        None,
        json!({"method":"oidc"}),
    )
    .await?;
    let workspace_url = format!("{}/app", state.config.public_url.trim_end_matches('/'));
    Ok((jar, Redirect::to(&workspace_url)))
}
