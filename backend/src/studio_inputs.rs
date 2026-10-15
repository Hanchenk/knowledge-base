//! Private reference material, kept outside the shared knowledge index.
use crate::{
    auth::{audit, Actor},
    db::{id, now, s, Record},
    error::{AppError, Result},
    AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_FILES: usize = 8;
const MAX_PIXELS: u64 = 25_000_000;
pub fn capabilities() -> Value {
    json!({"enabled":true,"max_files":MAX_FILES,"max_size_bytes":MAX_BYTES,
        "accept":["image/png","image/jpeg","image/webp",".txt",".md",".csv",".json",".pdf",".docx",".pptx",".xlsx"]})
}
pub fn public(row: &Record) -> Value {
    json!({"id":row["id"],"name":row["name"],"kind":row["kind"],"mime_type":row["mime_type"],"size":row["size"],"created_at":row["created_at"]})
}
pub async fn owned(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    state
        .db
        .one(
            "SELECT * FROM studio_inputs WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)
}
pub async fn selected(state: &AppState, actor: &Actor, ids: &[String]) -> Result<Vec<Record>> {
    if ids.len() > MAX_FILES {
        return Err(AppError::bad("每次最多添加 8 个参考文件"));
    }
    let mut rows = Vec::new();
    for key in ids {
        if rows.iter().any(|r: &Record| s(r, "id") == key) {
            return Err(AppError::bad("参考文件不能重复"));
        }
        rows.push(owned(state, actor, key).await?);
    }
    Ok(rows)
}
fn format(name: &str, data: &[u8]) -> Result<(&'static str, &'static str)> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(("image/png", "image"));
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return Ok(("image/jpeg", "image"));
    }
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return Ok(("image/webp", "image"));
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "txt" | "md" | "csv" | "json" if !data.contains(&0) => {
            Ok(("text/plain; charset=utf-8", "document"))
        }
        "pdf" if data.starts_with(b"%PDF-") => Ok(("application/pdf", "document")),
        "docx" if data.starts_with(b"PK\x03\x04") => Ok((
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "document",
        )),
        "pptx" if data.starts_with(b"PK\x03\x04") => Ok((
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "document",
        )),
        "xlsx" if data.starts_with(b"PK\x03\x04") => Ok((
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "document",
        )),
        _ => Err(AppError::bad(
            "支持 PNG、JPEG、WebP、TXT、Markdown、CSV、JSON、PDF、DOCX、PPTX 和 XLSX 文件",
        )),
    }
}
pub fn dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") && data.get(12..16) == Some(b"IHDR") {
        return Some((
            u32::from_be_bytes(data.get(16..20)?.try_into().ok()?),
            u32::from_be_bytes(data.get(20..24)?.try_into().ok()?),
        ));
    }
    if data.starts_with(b"\xff\xd8") {
        let mut i = 2;
        while i + 4 < data.len() {
            if data[i] != 0xff {
                return None;
            }
            let marker = data[i + 1];
            if marker == 0xff {
                i += 1;
                continue;
            }
            if marker == 0xd9 || marker == 0xda {
                break;
            }
            let length = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
            if length < 2 || i + 2 + length > data.len() {
                return None;
            }
            if [
                0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
            ]
            .contains(&marker)
                && length >= 7
            {
                return Some((
                    u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32,
                    u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32,
                ));
            }
            i += 2 + length;
        }
    }
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        let u24 = |p: usize| -> Option<u32> {
            let b = data.get(p..p + 3)?;
            Some(b[0] as u32 | (b[1] as u32) << 8 | (b[2] as u32) << 16)
        };
        if data.get(12..16) == Some(b"VP8X") {
            return Some((u24(24)? + 1, u24(27)? + 1));
        }
        if data.get(12..16) == Some(b"VP8 ") && data.get(23..26) == Some(b"\x9d\x01\x2a") {
            return Some((
                u16::from_le_bytes(data.get(26..28)?.try_into().ok()?) as u32 & 0x3fff,
                u16::from_le_bytes(data.get(28..30)?.try_into().ok()?) as u32 & 0x3fff,
            ));
        }
        if data.get(12..16) == Some(b"VP8L") && data.get(20) == Some(&0x2f) {
            let bits = u32::from_le_bytes(data.get(21..25)?.try_into().ok()?);
            return Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
        }
    }
    None
}
// Read IFD0's orientation without decoding the image or starting Python for an
// ordinary JPEG. The pixel transform below uses the deployment's existing Pillow.
fn jpeg_orientation(data: &[u8]) -> Option<u16> {
    if !data.starts_with(b"\xff\xd8") {
        return None;
    }
    let mut position = 2;
    while position + 4 <= data.len() {
        if data[position] != 0xff {
            return None;
        }
        let marker = data[position + 1];
        if marker == 0xff {
            position += 1;
            continue;
        }
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            position += 2;
            continue;
        }
        let length = u16::from_be_bytes([data[position + 2], data[position + 3]]) as usize;
        if length < 2 {
            return None;
        }
        let end = position.checked_add(2 + length)?;
        let segment = data.get(position + 4..end)?;
        if marker == 0xe1 && segment.starts_with(b"Exif\0\0") {
            let tiff = segment.get(6..)?;
            let little = match tiff.get(..2)? {
                b"II" => true,
                b"MM" => false,
                _ => return None,
            };
            let short = |at: usize| -> Option<u16> {
                let raw = tiff.get(at..at.checked_add(2)?)?.try_into().ok()?;
                Some(if little {
                    u16::from_le_bytes(raw)
                } else {
                    u16::from_be_bytes(raw)
                })
            };
            let long = |at: usize| -> Option<u32> {
                let raw = tiff.get(at..at.checked_add(4)?)?.try_into().ok()?;
                Some(if little {
                    u32::from_le_bytes(raw)
                } else {
                    u32::from_be_bytes(raw)
                })
            };
            if short(2)? != 42 {
                return None;
            }
            let directory = long(4)? as usize;
            let count = short(directory)? as usize;
            for entry in 0..count {
                let at = directory.checked_add(2 + entry * 12)?;
                if short(at)? == 0x0112 && short(at + 2)? == 3 && long(at + 4)? == 1 {
                    let orientation = short(at + 8)?;
                    return (1..=8).contains(&orientation).then_some(orientation);
                }
            }
        }
        position = end;
    }
    None
}
const NORMALIZE_JPEG: &str = r#"
import io, sys
if sys.platform == 'linux':
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
from PIL import Image, ImageOps
maximum, pixels = int(sys.argv[1]), int(sys.argv[2])
Image.MAX_IMAGE_PIXELS = pixels
try:
    raw = sys.stdin.buffer.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError('input too large')
    with Image.open(io.BytesIO(raw)) as source:
        if source.format != 'JPEG' or source.width * source.height > pixels:
            raise ValueError('invalid JPEG dimensions')
        upright = ImageOps.exif_transpose(source)
        if upright.mode not in ('RGB', 'L'):
            upright = upright.convert('RGB')
        output = io.BytesIO()
        options = {'quality': 95, 'subsampling': 0}
        if source.info.get('icc_profile'):
            options['icc_profile'] = source.info['icc_profile']
        exif = upright.getexif()
        if exif:
            options['exif'] = exif.tobytes()
        upright.save(output, format='JPEG', **options)
        encoded = output.getvalue()
        if len(encoded) > maximum:
            sys.exit(3)
        sys.stdout.buffer.write(encoded)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
"#;
async fn normalize_orientation(state: &AppState, data: &[u8]) -> Result<Option<Vec<u8>>> {
    let Some(orientation @ 2..=8) = jpeg_orientation(data) else {
        return Ok(None);
    };
    let (width, height) = dimensions(data).ok_or_else(|| AppError::bad("图片头部无效"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(AppError::bad("图片不能超过 2500 万像素"));
    }
    let mut command = tokio::process::Command::new(&state.config.processor_python);
    command
        .arg("-c")
        .arg(NORMALIZE_JPEG)
        .arg(MAX_BYTES.to_string())
        .arg(MAX_PIXELS.to_string())
        .env_clear()
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| AppError::bad("照片方向处理器未启动，请检查 Python / Pillow 解析环境"))?;
    let operation = async {
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::bad("无法读取照片数据"))?;
        input
            .write_all(data)
            .await
            .map_err(|_| AppError::bad("照片方向处理失败，请检查图片格式"))?;
        drop(input);
        child
            .wait_with_output()
            .await
            .map_err(|_| AppError::bad("照片方向处理失败"))
    };
    let output = tokio::time::timeout(Duration::from_secs(30), operation)
        .await
        .map_err(|_| AppError::bad("照片方向处理超时，请缩小图片后重试"))??;
    if output.status.code() == Some(3) || output.stdout.len() > MAX_BYTES {
        return Err(AppError::bad(
            "照片方向处理后的文件超过 20 MB，请缩小图片后重试",
        ));
    }
    if !output.status.success() {
        return Err(AppError::bad(
            "照片方向处理失败，请检查图片格式及 Pillow 解析环境",
        ));
    }
    let expected = if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    };
    if !output.stdout.starts_with(b"\xff\xd8\xff")
        || dimensions(&output.stdout) != Some(expected)
        || jpeg_orientation(&output.stdout).is_some_and(|value| value != 1)
    {
        return Err(AppError::bad("照片方向处理结果无效"));
    }
    Ok(Some(output.stdout))
}
async fn extract_text(state: &AppState, actor: &Actor, name: &str, bytes: &[u8]) -> Result<String> {
    if ["txt", "md", "csv", "json"].contains(
        &name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
    ) {
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(AppError::bad("文本参考文件不能超过 2 MB"));
        }
        return String::from_utf8(bytes.to_vec())
            .map(|t| {
                t.trim_start_matches('\u{feff}')
                    .chars()
                    .take(16000)
                    .collect()
            })
            .map_err(|_| AppError::bad("文本参考文件请使用 UTF-8 编码"));
    }
    let snapshot = state.for_tenant(&actor.tenant_id).await?;
    let temporary = std::env::temp_dir().join(format!("atlas-studio-{}", id()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .await
        .map_err(anyhow::Error::from)?;
    if let Err(error) = file.write_all(bytes).await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(anyhow::Error::from(error).into());
    }
    drop(file);
    let result = async {
        let mut cmd = tokio::process::Command::new(&snapshot.config.processor_python);
        cmd.arg(&snapshot.config.processor_script)
            .arg(&temporary)
            .arg(name)
            .env_clear()
            .env("PYTHONUTF8", "1")
            .kill_on_drop(true);
        if snapshot.config.vision() {
            cmd.arg("--images");
        }
        let output = tokio::time::timeout(Duration::from_secs(120), cmd.output())
            .await
            .map_err(|_| AppError::bad("参考文件解析超时，请拆分文件"))?
            .map_err(|_| AppError::bad("参考文件解析器未启动，请检查 Python 解析环境"))?;
        if !output.status.success() {
            return Err(AppError::bad(
                "参考文件无法解析；扫描 PDF 需要启用视觉模型，请检查格式或使用文字版",
            ));
        }
        if output.stdout.len() > 80_000_000 {
            return Err(AppError::bad("参考文件内容过大，请拆分文件"));
        }
        let records: Vec<Value> = serde_json::from_slice(&output.stdout)
            .map_err(|_| AppError::bad("参考文件解析结果无效"))?;
        let mut parts = Vec::new();
        let mut visual_pages = 0;
        for record in records.iter().take(250) {
            let mut text = record["text"].as_str().unwrap_or("").to_owned();
            if let Some(image) = record["image"].as_str() {
                if visual_pages >= 8 {
                    continue;
                }
                visual_pages += 1;
                use base64::Engine;
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(image)
                    .map_err(|_| AppError::bad("参考文件图像无效"))?;
                text = crate::ai::vision(
                    &snapshot,
                    &raw,
                    record["mime"].as_str().unwrap_or("image/jpeg"),
                )
                .await?;
            }
            if !text.trim().is_empty() {
                parts.push(format!(
                    "第 {} 页：{}",
                    record["page"].as_i64().unwrap_or(1),
                    text
                ));
            }
            if parts.iter().map(String::len).sum::<usize>() > 48000 {
                break;
            }
        }
        let text = parts.join("\n");
        if text.trim().is_empty() {
            return Err(AppError::bad("参考文件没有可读取的内容"));
        }
        Ok(text.chars().take(16000).collect())
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}
async fn persist(
    state: &AppState,
    actor: &Actor,
    name: &str,
    data: &[u8],
    mime: &str,
    kind: &str,
    text: &str,
) -> Result<Json<Value>> {
    let key = id();
    let storage_key = format!("{}/studio-inputs/{key}.bin", actor.tenant_id);
    state.storage.put(&storage_key, data).await?;
    if let Err(error)=state.db.exec("INSERT INTO studio_inputs(id,tenant_id,user_id,name,kind,mime_type,storage_key,size,extracted_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(name),json!(kind),json!(mime),json!(storage_key),json!(data.len() as i64),json!(text),json!(now())]).await {
        let _=state.storage.delete(&storage_key).await;
        return Err(error.into());
    }
    audit(
        state,
        &actor.tenant_id,
        &actor.id,
        "studio.attachment",
        Some(&key),
        json!({"kind":kind,"size":data.len()}),
    )
    .await?;
    Ok(Json(public(&owned(state, actor, &key).await?)))
}
pub async fn upload(
    State(state): State<AppState>,
    actor: Actor,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    actor.browser()?;
    let mut file = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad("读取上传文件失败"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        if file.is_some() {
            return Err(AppError::bad("一次上传一个参考文件"));
        }
        let name = field
            .file_name()
            .unwrap_or("reference.png")
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("reference.png")
            .chars()
            .filter(|c| !c.is_control())
            .take(160)
            .collect::<String>();
        let mut data = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| AppError::bad("读取上传文件失败"))?
        {
            if data.len() + chunk.len() > MAX_BYTES {
                return Err(AppError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "单个参考文件不能超过 20 MB".into(),
                ));
            }
            data.extend_from_slice(&chunk);
        }
        if data.is_empty() {
            return Err(AppError::bad("不能上传空文件"));
        }
        file = Some((name, data));
    }
    let (name, mut data) = file.ok_or_else(|| AppError::bad("请选择参考文件"))?;
    let (mime, kind) = format(&name, &data)?;
    let text = if kind == "image" {
        let (width, height) = dimensions(&data).ok_or_else(|| AppError::bad("图片头部无效"))?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
            return Err(AppError::bad("图片不能超过 2500 万像素"));
        }
        if let Some(upright) = normalize_orientation(&state, &data).await? {
            data = upright;
        }
        String::new()
    } else {
        extract_text(&state, &actor, &name, &data).await?
    };
    persist(&state, &actor, &name, &data, mime, kind, &text).await
}
pub async fn read(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Response> {
    actor.browser()?;
    let row = owned(&state, &actor, &key).await?;
    let bytes = state.storage.get(s(&row, "storage_key")).await?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, s(&row, "mime_type"))
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            if s(&row, "kind") == "image" {
                "inline"
            } else {
                "attachment"
            },
        )
        .body(Body::from(bytes))
        .unwrap())
}
pub async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let row = owned(&state, &actor, &key).await?;
    let changed=state.db.exec("DELETE FROM studio_inputs WHERE id=? AND NOT EXISTS (SELECT 1 FROM studio_request_inputs WHERE attachment_id=?)",vec![json!(key),json!(key)]).await?;
    if changed == 0 {
        return Err(AppError::bad("已用于创作的参考文件会随创作记录保留"));
    }
    state.storage.delete(s(&row, "storage_key")).await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn reference(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let asset = state
        .db
        .one(
            "SELECT * FROM studio_assets WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    if s(&asset, "kind") != "image" {
        return Err(AppError::bad("目前支持把图片作品用作参考图"));
    }
    let mut bytes = state.storage.get(s(&asset, "storage_key")).await?;
    if let Some(upright) = normalize_orientation(&state, &bytes).await? {
        bytes = upright;
    }
    persist(
        &state,
        &actor,
        "作品参考图",
        &bytes,
        s(&asset, "mime_type"),
        "image",
        "",
    )
    .await
}
pub async fn request_material(
    state: &AppState,
    actor: &Actor,
    project: &str,
    request: &str,
) -> Result<Vec<Record>> {
    Ok(state.db.rows("SELECT i.*,r.role FROM studio_request_inputs r JOIN studio_inputs i ON i.id=r.attachment_id WHERE r.project_id=? AND r.request_id=? AND i.tenant_id=? AND i.user_id=? ORDER BY r.position",vec![json!(project),json!(request),json!(actor.tenant_id),json!(actor.id)]).await?)
}
