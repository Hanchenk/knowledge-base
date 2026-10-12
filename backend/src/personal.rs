use crate::{
    auth::Actor,
    db::{id, n, now, s, Record},
    error::Result,
    AppState,
};
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub async fn get(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let pref = state
        .db
        .one(
            "SELECT auto_archive FROM user_preferences WHERE user_id=?",
            vec![json!(actor.id)],
        )
        .await?;
    let space = state
        .db
        .one(
            "SELECT space_id FROM personal_spaces WHERE user_id=?",
            vec![json!(actor.id)],
        )
        .await?;
    Ok(Json(
        json!({"auto_archive":pref.as_ref().is_some_and(|r|n(r,"auto_archive")==1),"space_id":space.map(|r|r["space_id"].clone())}),
    ))
}
#[derive(Deserialize)]
pub struct Input {
    pub auto_archive: bool,
}
pub async fn save(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<Input>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let mut tx = state.db.pool.begin().await?;
    state.db.tx_exec(&mut tx,"INSERT INTO user_preferences(user_id,auto_archive) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET auto_archive=excluded.auto_archive",vec![json!(actor.id),json!(input.auto_archive)]).await?;
    if input.auto_archive {
        ensure_space(&state, &mut tx, &actor.tenant_id, &actor.id).await?;
    }
    tx.commit().await?;
    get(State(state), actor).await
}
async fn ensure_space(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    tenant: &str,
    user: &str,
) -> anyhow::Result<String> {
    // Preferences row is locked by both the switch and completion. The same user cannot create two spaces.
    if let Some(row) = state
        .db
        .tx_one(
            tx,
            "SELECT space_id FROM personal_spaces WHERE user_id=?",
            vec![json!(user)],
        )
        .await?
    {
        return Ok(s(&row, "space_id").into());
    }
    let key = id();
    state.db.tx_exec(tx,"INSERT INTO spaces(id,tenant_id,name,description,created_by,created_at) VALUES(?,?,'个人知识库','个人上传与创作内容，仅本人可访问',?,?)",vec![json!(key),json!(tenant),json!(user),json!(now())]).await?;
    state
        .db
        .tx_exec(
            tx,
            "INSERT INTO personal_spaces(space_id,user_id) VALUES(?,?)",
            vec![json!(key), json!(user)],
        )
        .await?;
    Ok(key)
}
/// Runs in the generation completion transaction. A retry cannot create a second archive.
pub async fn archive(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    job: &Record,
    asset_id: &str,
    bytes: &[u8],
    mime: &str,
    extension: &str,
) -> anyhow::Result<()> {
    let user = s(job, "user_id");
    let tenant = s(job, "tenant_id");
    state
        .db
        .tx_exec(
            tx,
            "INSERT INTO user_preferences(user_id) VALUES(?) ON CONFLICT(user_id) DO NOTHING",
            vec![json!(user)],
        )
        .await?;
    state
        .db
        .tx_exec(
            tx,
            "UPDATE user_preferences SET auto_archive=auto_archive WHERE user_id=?",
            vec![json!(user)],
        )
        .await?;
    let pref = state
        .db
        .tx_one(
            tx,
            "SELECT auto_archive FROM user_preferences WHERE user_id=?",
            vec![json!(user)],
        )
        .await?
        .unwrap();
    if n(&pref, "auto_archive") != 1 {
        return Ok(());
    }
    if state
        .db
        .tx_one(
            tx,
            "SELECT asset_id FROM studio_archives WHERE asset_id=?",
            vec![json!(asset_id)],
        )
        .await?
        .is_some()
    {
        return Ok(());
    }
    let space = ensure_space(state, tx, tenant, user).await?;
    let document = id();
    let key = format!("{tenant}/{document}/original.{extension}");
    state.storage.put_tx(tx, &key, bytes).await?;
    let title = format!(
        "创作 · {}",
        s(job, "prompt").chars().take(100).collect::<String>()
    );
    let filename = format!("{document}.{extension}");
    let checksum = format!("{:x}", Sha256::digest(bytes));
    state.db.tx_exec(tx,"INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,tags,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![json!(document),json!(tenant),json!(space),json!(title),json!(filename),json!(mime),json!(key),json!(bytes.len() as i64),json!(checksum),json!("[\"创作台\",\"自动归档\"]"),json!(user),json!(now()),json!(now())]).await?;
    state.db.tx_exec(tx,"INSERT INTO document_versions(id,document_id,version,storage_key,filename,mime_type,checksum,size,created_by,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)",vec![json!(id()),json!(document),json!(key),json!(filename),json!(mime),json!(checksum),json!(bytes.len() as i64),json!(user),json!(now())]).await?;
    state
        .db
        .tx_exec(
            tx,
            "INSERT INTO studio_archives(asset_id,document_id) VALUES(?,?)",
            vec![json!(asset_id), json!(document)],
        )
        .await?;
    state.db.tx_exec(tx,"INSERT INTO index_jobs(id,tenant_id,document_id,version,available_at,created_at) VALUES(?,?,?,1,?,?)",vec![json!(id()),json!(tenant),json!(document),json!(now()),json!(now())]).await?;
    Ok(())
}
