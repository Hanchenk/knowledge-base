use crate::{
    acl,
    auth::{audit, Actor},
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_UPLOAD_BYTES: usize = 500 * 1024 * 1024;
// Includes multipart headers and the small text fields surrounding one file.
pub const MAX_UPLOAD_BODY_BYTES: usize = MAX_UPLOAD_BYTES + 2 * 1024 * 1024;

fn upload_error(error: axum::extract::multipart::MultipartError) -> AppError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        AppError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "单个文件不能超过 500 MB".into(),
        )
    } else {
        AppError::bad("读取上传数据失败，请重新选择文件后重试")
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub space_id: Option<String>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
pub async fn list(
    State(state): State<AppState>,
    actor: Actor,
    Query(input): Query<ListQuery>,
) -> Result<Json<Value>> {
    actor.scope("document.read")?;
    let rights = acl::all_rights(&state, &actor).await?;
    let spaces: Vec<_> = rights
        .iter()
        .filter(|(id, r)| r.can_view && input.space_id.as_ref().is_none_or(|v| *id == v))
        .map(|(id, _)| id.clone())
        .collect();
    if input
        .space_id
        .as_ref()
        .is_some_and(|id| !spaces.contains(id))
    {
        return Err(AppError::forbidden());
    }
    if spaces.is_empty() {
        return Ok(Json(json!({"items":[],"total":0})));
    }
    let placeholders = vec!["?"; spaces.len()].join(",");
    let mut args = vec![json!(actor.tenant_id)];
    args.extend(spaces.iter().map(|s| json!(s)));
    let mut filter = format!("d.tenant_id=? AND d.deleted=0 AND d.space_id IN ({placeholders})");
    if let Some(query) = input.q {
        filter.push_str(" AND lower(d.title) LIKE ? ESCAPE '\\'");
        args.push(json!(format!(
            "%{}%",
            query
                .to_lowercase()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )));
    }
    let total = state
        .db
        .one(
            &format!("SELECT COUNT(*) AS count FROM documents d WHERE {filter}"),
            args.clone(),
        )
        .await?
        .unwrap();
    args.push(json!(input.limit.unwrap_or(50).clamp(1, 100)));
    args.push(json!(input.offset.unwrap_or(0).max(0)));
    let items=state.db.rows(&format!("SELECT d.id,d.space_id,d.title,d.filename,d.mime_type,d.size,d.version,d.indexed_version,d.status,d.error,d.tags,d.created_by,d.created_at,d.updated_at,s.name AS space_name,u.name AS author FROM documents d JOIN spaces s ON s.id=d.space_id JOIN users u ON u.id=d.created_by WHERE {filter} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?"),args).await?;
    Ok(Json(json!({"items":items,"total":n(&total,"count")})))
}
pub async fn accessible(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    actor.scope("document.read")?;
    let doc = state
        .db
        .one(
            "SELECT * FROM documents WHERE id=? AND tenant_id=? AND deleted=0",
            vec![json!(key), json!(actor.tenant_id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    acl::require(state, actor, s(&doc, "space_id"), "view").await?;
    Ok(doc)
}
pub async fn get(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(read(&state, &actor, &key).await?))
}
pub async fn status(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    let doc = accessible(&state, &actor, &key).await?;
    Ok(Json(
        json!({"id":doc["id"],"status":doc["status"],"error":doc["error"],"version":doc["version"],"indexed_version":doc["indexed_version"]}),
    ))
}
pub async fn read(state: &AppState, actor: &Actor, key: &str) -> Result<Value> {
    let mut doc = accessible(state, actor, key).await?;
    doc.remove("storage_key");
    doc.remove("checksum");
    let chunks=state.db.rows("SELECT id,text,page,kind,image_key,position FROM chunks WHERE document_id=? AND version=? ORDER BY position LIMIT 4000",vec![json!(key),json!(n(&doc,"version"))]).await?;
    let chunks: Vec<_> = chunks
        .into_iter()
        .map(|mut row| {
            let image = !s(&row, "image_key").is_empty();
            row.remove("image_key");
            row.insert(
                "image_url".into(),
                if image {
                    json!(format!("/api/chunks/{}/image", s(&row, "id")))
                } else {
                    Value::Null
                },
            );
            row
        })
        .collect();
    audit(
        state,
        &actor.tenant_id,
        &actor.id,
        "document.read",
        Some(key),
        json!({"api_key_id":actor.key_id}),
    )
    .await?;
    Ok(json!({"document":doc,"chunks":chunks}))
}
#[derive(Deserialize)]
pub struct TextInput {
    pub space_id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}
pub async fn create_text(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<TextInput>,
) -> Result<Json<Value>> {
    Ok(Json(text(&state, &actor, input).await?))
}
pub async fn text(state: &AppState, actor: &Actor, input: TextInput) -> Result<Value> {
    let title = crate::org::label(&input.title, 200)?;
    if input.content.trim().is_empty() || input.content.len() > 1_000_000 {
        return Err(AppError::bad("正文不能为空且不能超过 1 MB"));
    }
    let filename = format!("{title}.md");
    create(
        state,
        actor,
        &input.space_id,
        NewSource {
            title: &title,
            filename: &filename,
            mime: "text/markdown",
            bytes: input.content.as_bytes(),
            tags: input.tags,
        },
    )
    .await
}
fn file_type(filename: &str, bytes: &[u8]) -> Result<&'static str> {
    let extension = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match extension.as_str() {
        "pdf" if bytes.starts_with(b"%PDF-") => "application/pdf",
        "docx" if bytes.starts_with(b"PK") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        "xlsx" if bytes.starts_with(b"PK") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        "pptx" if bytes.starts_with(b"PK") => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => "image/jpeg",
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "image/webp",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        _ => return Err(AppError::bad(
            "仅支持 PDF、DOCX、XLSX、PPTX、TXT、MD、CSV、PNG、JPEG、WebP，且文件内容必须与类型一致",
        )),
    };
    Ok(mime)
}
pub async fn upload(
    State(state): State<AppState>,
    actor: Actor,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    actor.scope("document.write")?;
    let state = state.for_tenant(&actor.tenant_id).await?;
    let mut space_id = String::new();
    let mut title = String::new();
    let mut file = None;
    let mut replace_id = None;
    while let Some(field) = multipart.next_field().await.map_err(upload_error)? {
        match field.name().unwrap_or("") {
            "space_id" => {
                space_id = field
                    .text()
                    .await
                    .map_err(|_| AppError::bad("空间参数无效"))?
            }
            "title" => {
                title = field
                    .text()
                    .await
                    .map_err(|_| AppError::bad("标题参数无效"))?
            }
            "replace_id" => {
                replace_id = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::bad("版本参数无效"))?,
                )
            }
            "file" => {
                let filename = field.file_name().unwrap_or("document.txt").to_owned();
                let bytes = field.bytes().await.map_err(upload_error)?;
                file = Some((filename, bytes));
            }
            _ => {}
        }
    }
    let (filename, bytes) = file.ok_or_else(|| AppError::bad("请选择文件"))?;
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "单个文件不能超过 500 MB".into(),
        ));
    }
    if bytes.is_empty() || filename.len() > 240 {
        return Err(AppError::bad("文件不能为空，文件名不能超过 240 字节"));
    }
    let mime = file_type(&filename, &bytes)?;
    if mime.starts_with("image/") && !state.config.vision() {
        return Err(AppError::bad(
            "图片索引需要先配置 VISION_MODEL；配置后支持图文双向检索",
        ));
    }
    if title.trim().is_empty() {
        title = filename
            .rsplit_once('.')
            .map(|(name, _)| name)
            .unwrap_or(&filename)
            .to_owned();
    }
    let title = crate::org::label(&title, 200)?;
    if let Some(key) = replace_id {
        let doc = accessible(&state, &actor, &key).await?;
        let rights = acl::require(&state, &actor, s(&doc, "space_id"), "create").await?;
        if !rights.can_manage && s(&doc, "created_by") != actor.id {
            return Err(AppError::forbidden());
        }
        let storage_key = format!("{}/{}/{}", actor.tenant_id, key, id());
        state.storage.put(&storage_key, &bytes).await?;
        let checksum = format!("{:x}", Sha256::digest(&bytes));
        let mut tx = state.db.pool.begin().await?;
        let updated=state.db.tx_one(&mut tx,"UPDATE documents SET title=?,filename=?,mime_type=?,storage_key=?,size=?,checksum=?,version=version+1,status='queued',error=NULL,updated_at=? WHERE id=? AND tenant_id=? AND version=? AND deleted=0 RETURNING *",vec![json!(title),json!(filename),json!(mime),json!(storage_key),json!(bytes.len() as i64),json!(checksum),json!(now()),json!(key),json!(actor.tenant_id),json!(n(&doc,"version"))]).await?.ok_or_else(||AppError::bad("文档已被其他人更新，请刷新后重试"))?;
        state.db.tx_exec(&mut tx,"INSERT INTO document_versions(id,document_id,version,storage_key,filename,mime_type,checksum,size,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",vec![json!(id()),json!(key),json!(n(&updated,"version")),json!(storage_key),json!(filename),json!(mime),json!(checksum),json!(bytes.len() as i64),json!(actor.id),json!(now())]).await?;
        queue_tx(&state, &mut tx, &updated).await?;
        tx.commit().await?;
        audit(
            &state,
            &actor.tenant_id,
            &actor.id,
            "document.version.create",
            Some(&key),
            json!({"version":n(&updated,"version")}),
        )
        .await?;
        Ok(Json(
            json!({"id":key,"version":n(&updated,"version"),"status":"queued"}),
        ))
    } else {
        Ok(Json(
            create(
                &state,
                &actor,
                &space_id,
                NewSource {
                    title: &title,
                    filename: &filename,
                    mime,
                    bytes: &bytes,
                    tags: vec![],
                },
            )
            .await?,
        ))
    }
}
struct NewSource<'a> {
    title: &'a str,
    filename: &'a str,
    mime: &'a str,
    bytes: &'a [u8],
    tags: Vec<String>,
}
async fn create(
    state: &AppState,
    actor: &Actor,
    space_id: &str,
    source: NewSource<'_>,
) -> Result<Value> {
    let NewSource {
        title,
        filename,
        mime,
        bytes,
        tags,
    } = source;
    actor.scope("document.write")?;
    acl::require(state, actor, space_id, "create").await?;
    if tags.len() > 20 || tags.iter().any(|s| s.len() > 80) {
        return Err(AppError::bad("最多 20 个标签，每个不能超过 80 字节"));
    }
    let key = id();
    let storage_key = format!("{}/{}/{}", actor.tenant_id, key, id());
    state.storage.put(&storage_key, bytes).await?;
    let checksum = format!("{:x}", Sha256::digest(bytes));
    let mut tx = state.db.pool.begin().await?;
    state.db.tx_exec(&mut tx,"INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,tags,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(actor.tenant_id),json!(space_id),json!(title),json!(filename),json!(mime),json!(storage_key),json!(bytes.len() as i64),json!(checksum),json!(json!(tags).to_string()),json!(actor.id),json!(now()),json!(now())]).await?;
    state.db.tx_exec(&mut tx,"INSERT INTO document_versions(id,document_id,version,storage_key,filename,mime_type,checksum,size,created_by,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)",vec![json!(id()),json!(key),json!(storage_key),json!(filename),json!(mime),json!(checksum),json!(bytes.len() as i64),json!(actor.id),json!(now())]).await?;
    let doc = state
        .db
        .tx_one(
            &mut tx,
            "SELECT * FROM documents WHERE id=?",
            vec![json!(key)],
        )
        .await?
        .unwrap();
    queue_tx(state, &mut tx, &doc).await?;
    tx.commit().await?;
    audit(
        state,
        &actor.tenant_id,
        &actor.id,
        "document.create",
        Some(&key),
        json!({"title":title,"api_key_id":actor.key_id}),
    )
    .await?;
    Ok(json!({"id":key,"version":1,"status":"queued"}))
}
async fn queue_tx(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    doc: &Record,
) -> anyhow::Result<()> {
    state.db.tx_exec(tx,"INSERT INTO index_jobs(id,tenant_id,document_id,version,available_at,created_at) VALUES(?,?,?,?,?,?)",vec![json!(id()),json!(s(doc,"tenant_id")),json!(s(doc,"id")),json!(n(doc,"version")),json!(now()),json!(now())]).await?;
    Ok(())
}
pub async fn delete(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.scope("document.write")?;
    let doc = accessible(&state, &actor, &key).await?;
    let rights = acl::require(&state, &actor, s(&doc, "space_id"), "create").await?;
    if !rights.can_manage && s(&doc, "created_by") != actor.id {
        return Err(AppError::forbidden());
    }
    let mut tx = state.db.pool.begin().await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE documents SET deleted=1,updated_at=? WHERE id=?",
            vec![json!(now()), json!(key)],
        )
        .await?;
    let versions = state
        .db
        .rows(
            "SELECT storage_key FROM document_versions WHERE document_id=?",
            vec![json!(key)],
        )
        .await?;
    let images = state
        .db
        .rows(
            "SELECT image_key FROM chunks WHERE document_id=? AND image_key IS NOT NULL",
            vec![json!(key)],
        )
        .await?;
    let keys = versions
        .iter()
        .map(|r| s(r, "storage_key").to_owned())
        .chain(images.iter().map(|r| s(r, "image_key").to_owned()))
        .collect::<std::collections::HashSet<_>>();
    state.db.tx_exec(&mut tx,"INSERT INTO document_cleanup_jobs(document_id,object_keys) VALUES(?,?) ON CONFLICT(document_id) DO NOTHING",vec![json!(key),json!(json!(keys).to_string())]).await?;
    crate::qdrant::enqueue(&state, &mut tx, &key).await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "DELETE FROM chunks WHERE document_id=?",
            vec![json!(key)],
        )
        .await?;
    state.db.tx_exec(&mut tx,"UPDATE index_jobs SET status='superseded',finished_at=? WHERE document_id=? AND status IN ('queued','processing')",vec![json!(now()),json!(key)]).await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "document.delete",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn retry(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.scope("document.write")?;
    let doc = accessible(&state, &actor, &key).await?;
    let rights = acl::require(&state, &actor, s(&doc, "space_id"), "create").await?;
    if !rights.can_manage && s(&doc, "created_by") != actor.id {
        return Err(AppError::forbidden());
    }
    let mut tx = state.db.pool.begin().await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE documents SET status='queued',error=NULL WHERE id=?",
            vec![json!(key)],
        )
        .await?;
    state.db.tx_exec(&mut tx,"UPDATE index_jobs SET status='superseded' WHERE document_id=? AND status IN ('queued','processing')",vec![json!(key)]).await?;
    queue_tx(&state, &mut tx, &doc).await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "document.reindex",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct VersionQuery {
    pub version: Option<i64>,
}
pub async fn versions(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    accessible(&state, &actor, &key).await?;
    Ok(Json(json!(state.db.rows("SELECT version,size,created_by,created_at FROM document_versions WHERE document_id=? ORDER BY version DESC",vec![json!(key)]).await?)))
}
pub async fn file(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Query(input): Query<VersionQuery>,
) -> Result<Response> {
    let doc = accessible(&state, &actor, &key).await?;
    let (storage_key, mime) = if let Some(version) = input.version {
        let version=state.db.one("SELECT storage_key,mime_type FROM document_versions WHERE document_id=? AND version=?",vec![json!(key),json!(version)]).await?.ok_or_else(AppError::missing)?;
        (
            s(&version, "storage_key").to_owned(),
            s(&version, "mime_type").to_owned(),
        )
    } else {
        (
            s(&doc, "storage_key").to_owned(),
            s(&doc, "mime_type").to_owned(),
        )
    };
    let bytes = state.storage.get(&storage_key).await?;
    acl::require(&state, &actor, s(&doc, "space_id"), "view").await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "document.download",
        Some(&key),
        json!({"version":input.version,"api_key_id":actor.key_id}),
    )
    .await?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).map_err(|_| AppError::bad("文件类型无效"))?,
    );
    // RFC 5987 encoding keeps Unicode filenames while preventing header injection.
    let filename = if let Some(version) = input.version {
        state
            .db
            .one(
                "SELECT filename FROM document_versions WHERE document_id=? AND version=?",
                vec![json!(key), json!(version)],
            )
            .await?
            .map(|v| s(&v, "filename").to_owned())
            .unwrap_or_else(|| "document".into())
    } else {
        s(&doc, "filename").to_owned()
    };
    let filename = filename.rsplit(['/', '\\']).next().unwrap_or("document");
    let encoded = filename
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"._-".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{encoded}"))
            .map_err(|_| AppError::bad("文件名无效"))?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}
pub async fn image(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Response> {
    actor.scope("document.read")?;
    let chunk=state.db.one("SELECT c.id,c.space_id,c.image_key FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=? AND c.tenant_id=? AND d.deleted=0 AND c.version=d.version",vec![json!(key),json!(actor.tenant_id)]).await?.ok_or_else(AppError::missing)?;
    acl::require(&state, &actor, s(&chunk, "space_id"), "view").await?;
    let bytes = state.storage.get(s(&chunk, "image_key")).await?;
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"RIFF") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

pub async fn cleanup_one(state: &AppState) -> anyhow::Result<bool> {
    let Some(job) = state
        .db
        .one(
            "SELECT * FROM document_cleanup_jobs WHERE status='queued' AND available_at<=? LIMIT 1",
            vec![json!(now())],
        )
        .await?
    else {
        return Ok(false);
    };
    let keys: Vec<String> = serde_json::from_str(s(&job, "object_keys"))?;
    for key in keys {
        if let Err(error) = state.storage.delete(&key).await {
            tracing::warn!(%error,"document objects cleanup will retry");
            state.db.exec("UPDATE document_cleanup_jobs SET available_at=?,error='对象删除失败，将自动重试' WHERE document_id=?",vec![json!(now()+30_000),json!(s(&job,"document_id"))]).await?;
            return Ok(true);
        }
    }
    state
        .db
        .exec(
            "UPDATE document_cleanup_jobs SET status='done',error=NULL WHERE document_id=?",
            vec![json!(s(&job, "document_id"))],
        )
        .await?;
    Ok(true)
}
