//! PostgreSQL is authoritative. Qdrant is a rebuildable vector index with a durable SQL outbox.
use crate::{
    db::{n, now, s, Record},
    AppState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn collection(state: &AppState) -> String {
    format!(
        "{}_{}_{}",
        state.config.qdrant_collection_prefix,
        state.config.embedding_dimensions,
        &format!("{:x}", Sha256::digest(state.config.embedding_identity()))[..20]
    )
}
async fn request(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Value,
) -> anyhow::Result<Value> {
    let r = state
        .http
        .request(
            method,
            format!("{}{}", state.config.qdrant_url.trim_end_matches('/'), path),
        )
        .timeout(std::time::Duration::from_secs(30))
        .header("api-key", &state.config.qdrant_api_key)
        .json(&body)
        .send()
        .await?;
    let status = r.status();
    // A removed historical collection is already clean. It must not block rebuilding current vectors.
    if status == reqwest::StatusCode::NOT_FOUND && path.ends_with("/points/delete?wait=true") {
        return Ok(json!({"status":"ok"}));
    }
    anyhow::ensure!(status.is_success(), "Qdrant request failed ({status})");
    Ok(r.json().await?)
}
async fn ensure_collection(state: &AppState, name: &str) -> anyhow::Result<()> {
    let r = state
        .http
        .get(format!(
            "{}/collections/{name}",
            state.config.qdrant_url.trim_end_matches('/')
        ))
        .header("api-key", &state.config.qdrant_api_key)
        .send()
        .await?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        let r = state
            .http
            .put(format!(
                "{}/collections/{name}",
                state.config.qdrant_url.trim_end_matches('/')
            ))
            .header("api-key", &state.config.qdrant_api_key)
            .json(
                &json!({"vectors":{"size":state.config.embedding_dimensions,"distance":"Cosine"}}),
            )
            .send()
            .await?;
        anyhow::ensure!(
            r.status().is_success() || r.status() == reqwest::StatusCode::CONFLICT,
            "Qdrant collection creation failed"
        );
        for field in ["tenant_id", "space_id", "document_id"] {
            request(
                state,
                reqwest::Method::PUT,
                &format!("/collections/{name}/index?wait=true"),
                json!({"field_name":field,"field_schema":"keyword"}),
            )
            .await?;
        }
    } else {
        anyhow::ensure!(r.status().is_success(), "Qdrant unavailable");
        let info: Value = r.json().await?;
        anyhow::ensure!(
            info["result"]["config"]["params"]["vectors"]["size"].as_u64()
                == Some(state.config.embedding_dimensions as u64),
            "Qdrant dimension mismatch"
        );
    }
    state
        .db
        .exec(
            "INSERT INTO vector_collections(name) VALUES(?) ON CONFLICT(name) DO NOTHING",
            vec![json!(name)],
        )
        .await?;
    Ok(())
}
pub async fn enqueue(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    document: &str,
) -> anyhow::Result<()> {
    if state.config.qdrant_url.is_empty() {
        return Ok(());
    }
    state.db.tx_exec(tx,"INSERT INTO vector_jobs(document_id) VALUES(?) ON CONFLICT(document_id) DO UPDATE SET revision=vector_jobs.revision+1,available_at=0,error=NULL",vec![json!(document)]).await?;
    Ok(())
}
pub async fn backfill(state: &AppState) -> anyhow::Result<()> {
    if !state.config.qdrant_url.is_empty() {
        state.db.exec("INSERT INTO vector_jobs(document_id) SELECT id FROM documents WHERE deleted=0 AND status='ready' ON CONFLICT(document_id) DO UPDATE SET revision=vector_jobs.revision+1,available_at=0",vec![]).await?;
    }
    Ok(())
}
async fn synchronize(state: &AppState, job: &Record) -> anyhow::Result<()> {
    let document = s(job, "document_id");
    let initial = state
        .db
        .one(
            "SELECT tenant_id FROM documents WHERE id=?",
            vec![json!(document)],
        )
        .await?
        .unwrap();
    let resolved = state.for_tenant(s(&initial, "tenant_id")).await?;
    let state = &resolved;
    let name = collection(state);
    ensure_collection(state, &name).await?;
    let collections = state
        .db
        .rows("SELECT name FROM vector_collections", vec![])
        .await?;
    let mut tx = state.db.pool.begin().await?;
    // Match the lock order used by publication/deletion. Avoid stale vectors from concurrent workers.
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE documents SET status=status WHERE id=?",
            vec![json!(document)],
        )
        .await?;
    let current = state
        .db
        .tx_one(
            &mut tx,
            "SELECT * FROM vector_jobs WHERE document_id=?",
            vec![json!(document)],
        )
        .await?
        .unwrap();
    if n(&current, "synced_revision") >= n(&current, "revision") {
        return Ok(());
    }
    let doc = state
        .db
        .tx_one(
            &mut tx,
            "SELECT * FROM documents WHERE id=?",
            vec![json!(document)],
        )
        .await?
        .unwrap();
    let rows=state.db.rows("SELECT id,text,embedding,embedding_model,space_id,version FROM chunks WHERE document_id=? AND embedding IS NOT NULL AND embedding_model=? AND version=?",vec![json!(document),json!(state.config.embedding_identity()),json!(n(&doc,"indexed_version"))]).await?;
    for c in collections {
        request(state,reqwest::Method::POST,&format!("/collections/{}/points/delete?wait=true",s(&c,"name")),json!({"filter":{"must":[{"key":"tenant_id","match":{"value":s(&doc,"tenant_id")}},{"key":"document_id","match":{"value":document}}]}})).await?;
    }
    if n(&doc, "deleted") == 0
        && s(&doc, "status") == "ready"
        && n(&doc, "version") == n(&doc, "indexed_version")
    {
        let points:Vec<Value>=rows.iter().map(|row|->anyhow::Result<Value>{let v:Vec<f64>=serde_json::from_str(s(row,"embedding"))?;anyhow::ensure!(v.len()==state.config.embedding_dimensions,"Vector dimensions mismatch");Ok(json!({"id":s(row,"id"),"vector":v,"payload":{"tenant_id":s(&doc,"tenant_id"),"space_id":s(row,"space_id"),"document_id":document,"version":n(row,"version")}}))}).collect::<anyhow::Result<_>>()?;
        for batch in points.chunks(128) {
            request(
                state,
                reqwest::Method::PUT,
                &format!("/collections/{name}/points?wait=true"),
                json!({"points":batch}),
            )
            .await?;
        }
    }
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE vector_jobs SET synced_revision=revision,error=NULL WHERE document_id=?",
            vec![json!(document)],
        )
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn run_one(state: &AppState) -> anyhow::Result<bool> {
    if state.config.qdrant_url.is_empty() {
        return Ok(false);
    }
    let Some(job)=state.db.one("SELECT * FROM vector_jobs WHERE synced_revision<revision AND available_at<=? ORDER BY available_at,document_id LIMIT 1",vec![json!(now())]).await? else {return Ok(false)};
    if let Err(error) = synchronize(state, &job).await {
        tracing::warn!(%error,"Qdrant sync will retry");
        state
            .db
            .exec(
                "UPDATE vector_jobs SET available_at=?,error=? WHERE document_id=? AND revision=?",
                vec![
                    json!(now() + 15_000),
                    json!(error.to_string().chars().take(300).collect::<String>()),
                    json!(s(&job, "document_id")),
                    json!(n(&job, "revision")),
                ],
            )
            .await?;
    }
    Ok(true)
}
pub async fn search(
    state: &AppState,
    tenant: &str,
    spaces: &[String],
    documents: &[String],
    vector: &[f64],
) -> anyhow::Result<Vec<String>> {
    if documents.is_empty() {
        return Ok(vec![]);
    }
    let name = collection(state);
    let r=request(state,reqwest::Method::POST,&format!("/collections/{name}/points/search"),json!({"vector":vector,"limit":64,"score_threshold":0.2,"with_payload":false,"with_vector":false,"filter":{"must":[{"key":"tenant_id","match":{"value":tenant}},{"key":"space_id","match":{"any":spaces}},{"key":"document_id","match":{"any":documents}}]}})).await?;
    Ok(r["result"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid Qdrant search result"))?
        .iter()
        .filter_map(|p| p["id"].as_str().map(String::from))
        .collect())
}
