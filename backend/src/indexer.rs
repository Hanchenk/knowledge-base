use crate::{
    ai,
    db::{id, n, now, s, Record},
    rag::tokens,
    AppState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::process::Command;

#[derive(Deserialize)]
struct Extracted {
    text: String,
    page: i64,
    kind: String,
    image: Option<String>,
    mime: Option<String>,
}
struct Prepared {
    text: String,
    page: i64,
    kind: String,
    image_key: Option<String>,
}
pub fn split_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let max = (start + 900).min(chars.len());
        let end = if max < chars.len() {
            (start + 650..max)
                .rev()
                .find(|i| matches!(chars[*i], '\n' | '。' | '！' | '？'))
                .map(|i| i + 1)
                .unwrap_or(max)
        } else {
            max
        };
        let value = chars[start..end].iter().collect::<String>();
        if !value.trim().is_empty() {
            chunks.push(value.trim().to_owned());
        }
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(140).max(start + 1);
    }
    chunks
}
pub async fn enqueue(state: &AppState, doc: &Record) -> anyhow::Result<()> {
    state.db.exec("INSERT INTO index_jobs(id,tenant_id,document_id,version,available_at,created_at) VALUES(?,?,?,?,?,?)",vec![json!(id()),json!(s(doc,"tenant_id")),json!(s(doc,"id")),json!(n(doc,"version")),json!(now()),json!(now())]).await?;
    Ok(())
}
pub async fn worker(state: AppState) {
    tracing::info!("index worker started");
    loop {
        if let Err(e) = crate::qdrant::run_one(&state).await {
            tracing::warn!(%e,"vector outbox failed");
        }
        if let Err(e) = crate::documents::cleanup_one(&state).await {
            tracing::warn!(%e,"document cleanup failed");
        }
        match run_one(&state).await {
            Ok(true) => {}
            Ok(false) => tokio::time::sleep(Duration::from_secs(2)).await,
            Err(error) => {
                tracing::error!(%error,"index worker error");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}
pub async fn run_one(state: &AppState) -> anyhow::Result<bool> {
    let worker_token = id();
    let clock = now();
    let job=state.db.one("UPDATE index_jobs SET status='processing',worker_token=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM index_jobs WHERE (status='queued' AND available_at<=?) OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT 1) AND ((status='queued' AND available_at<=?) OR (status='processing' AND lease_until<?)) RETURNING *",vec![json!(worker_token),json!(clock+120_000),json!(clock),json!(clock),json!(clock),json!(clock)]).await?;
    let Some(job) = job else {
        return crate::qdrant::run_one(state).await;
    };
    let doc = state
        .db
        .one(
            "SELECT * FROM documents WHERE id=? AND tenant_id=? AND deleted=0 AND version=?",
            vec![
                json!(s(&job, "document_id")),
                json!(s(&job, "tenant_id")),
                json!(n(&job, "version")),
            ],
        )
        .await?;
    let Some(doc) = doc else {
        state.db.exec("UPDATE index_jobs SET status='superseded',finished_at=? WHERE id=? AND worker_token=?",vec![json!(now()),json!(s(&job,"id")),json!(worker_token)]).await?;
        return Ok(true);
    };
    let resolved = state.for_tenant(s(&doc, "tenant_id")).await?;
    let state = &resolved;
    state.db.exec("UPDATE documents SET status='processing',error=NULL WHERE id=? AND version=? AND deleted=0",vec![json!(s(&doc,"id")),json!(n(&doc,"version"))]).await?;
    let result = {
        let work = prepare(state, &doc);
        tokio::pin!(work);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
        loop {
            tokio::select! {
                result=&mut work=>break result,
                _=heartbeat.tick()=>{let changed=state.db.exec("UPDATE index_jobs SET lease_until=? WHERE id=? AND worker_token=? AND status='processing'",vec![json!(now()+120_000),json!(s(&job,"id")),json!(worker_token)]).await?;anyhow::ensure!(changed==1,"Worker lease lost");}
            }
        }
    };
    match result {
        Ok((chunks, vectors)) => publish(state, &job, &doc, chunks, vectors).await?,
        Err(error) => {
            tracing::warn!(document_id=s(&doc,"id"),%error,"indexing failed");
            let attempts = n(&job, "attempts");
            let retry = attempts < 3;
            let detail = error.to_string().chars().take(500).collect::<String>();
            let mut tx = state.db.pool.begin().await?;
            let changed=state.db.tx_exec(&mut tx,"UPDATE index_jobs SET status=?,available_at=?,error=?,finished_at=?,lease_until=NULL WHERE id=? AND worker_token=? AND status='processing'",vec![json!(if retry{"queued"}else{"failed"}),json!(now()+30_000*attempts),json!(detail),json!(now()),json!(s(&job,"id")),json!(worker_token)]).await?;
            if changed == 1 {
                state.db.tx_exec(&mut tx,"UPDATE documents SET status=?,error=? WHERE id=? AND version=? AND deleted=0",vec![json!(if retry{"queued"}else{"failed"}),json!(detail),json!(s(&doc,"id")),json!(n(&doc,"version"))]).await?;
            }
            tx.commit().await?;
        }
    }
    Ok(true)
}
async fn prepare(state: &AppState, doc: &Record) -> anyhow::Result<(Vec<Prepared>, Vec<Vec<f64>>)> {
    let bytes = state.storage.get(s(doc, "storage_key")).await?;
    if let Some(archive)=state.db.one("SELECT j.prompt,j.model,j.kind,j.size,j.seconds FROM studio_archives a JOIN studio_assets sa ON sa.id=a.asset_id JOIN studio_jobs j ON j.id=sa.job_id WHERE a.document_id=?",vec![json!(s(doc,"id"))]).await? {
        let mut text=format!("创作内容：{}\n类型：{}\n模型：{}\n尺寸：{}\n时长：{} 秒",s(&archive,"prompt"),s(&archive,"kind"),s(&archive,"model"),s(&archive,"size"),n(&archive,"seconds"));
        let image=s(&archive,"kind")=="image";
        if image && state.config.vision() {text.push_str(&format!("\n图像内容：{}",ai::vision(state,&bytes,s(doc,"mime_type")).await?));}
        if !image {text.push_str("\n视频按创作提示词和元数据索引，未进行视频画面识别。");}
        let vectors=ai::embeddings(state,&[format!("{}\n{text}",s(doc,"title"))]).await?;
        return Ok((vec![Prepared{text,page:1,kind:if image{"image"}else{"video"}.into(),image_key:if image{Some(s(doc,"storage_key").into())}else{None}}],vectors));
    }

    let temporary = std::env::temp_dir().join(format!("atlas-{}", id()));
    tokio::fs::write(&temporary, &bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
    }
    let output = async {
        let mut command = Command::new(&state.config.processor_python);
        command
            .arg(&state.config.processor_script)
            .arg(&temporary)
            .arg(s(doc, "filename"))
            .kill_on_drop(true)
            .env_clear()
            .env("PYTHONUTF8", "1");
        if state.config.vision() {
            command.arg("--images");
        }
        tokio::time::timeout(Duration::from_secs(120), command.output()).await?
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    let output = output?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(500)
            .collect::<String>()
    );
    anyhow::ensure!(
        output.stdout.len() < 80_000_000,
        "Extraction output too large"
    );
    let extracted: Vec<Extracted> = serde_json::from_slice(&output.stdout)?;
    let mut prepared = Vec::new();
    for record in extracted {
        let (text, image_key) = if let Some(image) = record.image {
            let bytes = STANDARD.decode(image)?;
            let text = ai::vision(
                state,
                &bytes,
                record.mime.as_deref().unwrap_or("image/jpeg"),
            )
            .await?;
            let key = format!(
                "{}/{}/v{}/{}.jpg",
                s(doc, "tenant_id"),
                s(doc, "id"),
                n(doc, "version"),
                id()
            );
            state.storage.put(&key, &bytes).await?;
            (text, Some(key))
        } else {
            (record.text, None)
        };
        // The spreadsheet parser supplies complete, bounded rows with headers
        // and monthly snapshots. Character splitting destroys their meaning.
        let texts = if record.kind.starts_with("table") {
            anyhow::ensure!(
                text.chars().count() <= 24_000,
                "Table row exceeds extraction limits"
            );
            vec![text]
        } else {
            split_text(&text)
        };
        for text in texts {
            prepared.push(Prepared {
                text,
                page: record.page,
                kind: record.kind.clone(),
                image_key: image_key.clone(),
            });
        }
    }
    anyhow::ensure!(!prepared.is_empty(), "No extractable content");
    anyhow::ensure!(
        prepared.len() <= 4000,
        "Document exceeds 4,000 chunks; split it first"
    );
    let vectors = ai::embeddings(
        state,
        &prepared
            .iter()
            .map(|c| format!("{}\n{}", s(doc, "title"), c.text))
            .collect::<Vec<_>>(),
    )
    .await?;
    Ok((prepared, vectors))
}
async fn publish(
    state: &AppState,
    job: &Record,
    doc: &Record,
    chunks: Vec<Prepared>,
    vectors: Vec<Vec<f64>>,
) -> anyhow::Result<()> {
    let mut tx = state.db.pool.begin().await?;
    // Take the document write lock before checking version; publication is atomic with uploads/deletion.
    let changed = state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE documents SET status=status WHERE id=? AND version=? AND deleted=0",
            vec![json!(s(doc, "id")), json!(n(doc, "version"))],
        )
        .await?;
    let lease=state.db.tx_one(&mut tx,"SELECT id FROM index_jobs WHERE id=? AND worker_token=? AND status='processing' AND lease_until>?",vec![json!(s(job,"id")),json!(s(job,"worker_token")),json!(now())]).await?;
    if changed != 1 || lease.is_none() {
        state.db.tx_exec(&mut tx,"UPDATE index_jobs SET status='superseded',finished_at=? WHERE id=? AND worker_token=?",vec![json!(now()),json!(s(job,"id")),json!(s(job,"worker_token"))]).await?;
        tx.commit().await?;
        return Ok(());
    }
    state
        .db
        .tx_exec(
            &mut tx,
            "DELETE FROM chunks WHERE document_id=?",
            vec![json!(s(doc, "id"))],
        )
        .await?;
    for (position, chunk) in chunks.into_iter().enumerate() {
        let embedding: Value = vectors
            .get(position)
            .map(|v| json!(v).to_string().into())
            .unwrap_or(Value::Null);
        let chunk_id = id();
        state.db.tx_exec(&mut tx,"INSERT INTO chunks(id,tenant_id,space_id,document_id,version,text,search_tokens,page,kind,image_key,position,embedding,embedding_model) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![json!(chunk_id),json!(s(doc,"tenant_id")),json!(s(doc,"space_id")),json!(s(doc,"id")),json!(n(doc,"version")),json!(chunk.text),json!(tokens(&format!("{} {}",s(doc,"title"),chunk.text)).join(" ")),json!(chunk.page),json!(chunk.kind),json!(chunk.image_key),json!(position as i64),embedding.clone(),if vectors.is_empty(){Value::Null}else{json!(state.config.embedding_identity())}]).await?;
        if state.db.postgres && state.config.qdrant_url.is_empty() && !embedding.is_null() {
            state
                .db
                .tx_exec(
                    &mut tx,
                    "UPDATE chunks SET embedding_vector=CAST(? AS vector) WHERE id=?",
                    vec![embedding, json!(chunk_id)],
                )
                .await?;
        }
    }
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE documents SET status='ready',indexed_version=version,error=NULL WHERE id=?",
            vec![json!(s(doc, "id"))],
        )
        .await?;
    state.db.tx_exec(&mut tx,"UPDATE index_jobs SET status='done',finished_at=?,lease_until=NULL,error=NULL WHERE id=? AND worker_token=?",vec![json!(now()),json!(s(job,"id")),json!(s(job,"worker_token"))]).await?;
    crate::qdrant::enqueue(state, &mut tx, s(doc, "id")).await?;
    tx.commit().await?;
    Ok(())
}
