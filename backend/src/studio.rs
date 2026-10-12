//! Private creative projects; Pi chooses tools, Rust queues and persists media jobs.
use crate::{
    acl, agent,
    auth::{audit, Actor},
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    models::{self, Provider, Settings},
    AppState,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct Context {
    pub project_id: String,
    pub request_id: String,
    pub kind: String,
    pub image_size: String,
    pub video_size: String,
    pub seconds: i64,
    pub settings: Settings,
}
impl Context {
    pub fn available(&self) -> Value {
        json!({"image":self.settings.image.enabled && self.kind != "video","video":self.settings.video.enabled && self.kind != "image"})
    }
    pub fn instruction(&self) -> String {
        format!("你现在是创作台主智能体。用户选择的创作类型是 {}。整理用户要求为具体生成提示词，然后实际调用对应的 generate_image 或 generate_video 工具。明确要创作时不能仅回复文字或伪造生成结果；资料不足可以先澄清。每轮同一类型只能生成一个任务，不得擅自重复生成。工具返回的是异步任务，不代表作品完成；应说明已提交，生成进度与作品由页面展示。不得编造任务、图片、视频链接。图片尺寸 {}；视频尺寸 {}，时长 {} 秒。可根据要求使用授权知识库工具补充背景，但未经明确要求不要把企业内部资料发送给外部生成模型。",self.kind,self.image_size,self.video_size,self.seconds)
    }
}
async fn project(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    actor.browser()?;
    state
        .db
        .one(
            "SELECT * FROM studio_projects WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)
}
pub async fn capabilities(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let snapshot = state.for_tenant(&actor.tenant_id).await?;
    let (settings, _) = models::load(&state, &actor.tenant_id).await?;
    let image = settings.selected_media("image", None)?;
    let video = settings.selected_media("video", None)?;
    Ok(Json(
        json!({"agent":snapshot.config.agent_enabled && snapshot.config.chat(),"image":{"enabled":image.is_some(),"model":image.map(|m|&m.config.model)},"video":{"enabled":video.is_some(),"model":video.map(|m|&m.config.model)},"models":settings.media().iter().filter(|m|m.config.enabled).map(|m|json!({"id":m.id,"name":m.name,"kind":m.kind,"model":m.config.model})).collect::<Vec<_>>(),"default_image_id":image.map(|m|&m.id),"default_video_id":video.map(|m|&m.id),"web":snapshot.config.agent_web_enabled}),
    ))
}
pub async fn projects(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    Ok(Json(json!(state.db.rows("SELECT id,title,created_at,updated_at FROM studio_projects WHERE tenant_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 50",vec![json!(actor.tenant_id),json!(actor.id)]).await?)))
}
#[derive(Deserialize)]
pub struct NewProject {
    pub title: String,
}
pub async fn create_project(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<NewProject>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let title = input.title.trim().chars().take(60).collect::<String>();
    if title.is_empty() {
        return Err(AppError::bad("请输入创作标题"));
    }
    let key = id();
    state.db.exec("INSERT INTO studio_projects(id,tenant_id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(title),json!(now()),json!(now())]).await?;
    Ok(Json(json!({"id":key,"title":title})))
}
pub(crate) async fn valid_evidence(
    state: &AppState,
    actor: &Actor,
    citations: &[Value],
) -> Result<bool> {
    if citations.is_empty() {
        return Ok(true);
    }
    let rights = acl::all_rights(state, actor).await?;
    for c in citations {
        if !rights.get(c["space_id"].as_str().unwrap_or("")).is_some_and(|r|r.can_view) || state.db.one("SELECT id FROM documents WHERE id=? AND tenant_id=? AND version=? AND deleted=0",vec![c["document_id"].clone(),json!(actor.tenant_id),c["version"].clone()]).await?.is_none() {return Ok(false);}
    }
    Ok(true)
}
async fn project_messages(state: &AppState, actor: &Actor, key: &str) -> Result<Vec<Value>> {
    let mut rows=state.db.rows("SELECT id,role,content,citations,web_sources,tool_calls,created_at FROM studio_messages WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100",vec![json!(key)]).await?;
    rows.reverse();
    let mut result = Vec::new();
    for row in rows {
        let mut message = json!(row);
        for field in ["citations", "web_sources", "tool_calls"] {
            message[field] = serde_json::from_str(s(&row, field)).unwrap_or(json!([]));
        }
        if !valid_evidence(state, actor, message["citations"].as_array().unwrap()).await? {
            message["content"] =
                json!("此消息引用的资料已更新、删除或不再有访问权限，请重新提问。");
            for field in ["citations", "web_sources", "tool_calls"] {
                message[field] = json!([]);
            }
        }
        result.push(message);
    }
    Ok(result)
}
pub async fn get_project(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    let info = project(&state, &actor, &key).await?;
    let messages = project_messages(&state, &actor, &key).await?;
    let jobs=state.db.rows("SELECT id,kind,prompt,model,size,seconds,status,progress,error,created_at,finished_at FROM studio_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 100",vec![json!(key)]).await?;
    let assets=state.db.rows("SELECT a.id,a.job_id,a.kind,a.mime_type,a.size,a.created_at FROM studio_assets a JOIN studio_jobs j ON j.id=a.job_id WHERE j.project_id=? ORDER BY a.created_at DESC LIMIT 100",vec![json!(key)]).await?;
    Ok(Json(
        json!({"project":info,"messages":messages,"jobs":jobs,"assets":assets}),
    ))
}
#[derive(Deserialize)]
pub struct ChatInput {
    pub project_id: String,
    pub request_id: String,
    pub prompt: String,
    pub kind: String,
    pub image_size: String,
    pub video_size: String,
    pub seconds: i64,
    #[serde(default)]
    pub allow_web: bool,
    #[serde(default)]
    pub image_model_id: Option<String>,
    #[serde(default)]
    pub video_model_id: Option<String>,
}
pub async fn chat(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<ChatInput>,
) -> Result<Json<Value>> {
    project(&state, &actor, &input.project_id).await?;
    if uuid::Uuid::parse_str(&input.request_id).is_err()
        || input.prompt.trim().is_empty()
        || input.prompt.chars().count() > 4000
    {
        return Err(AppError::bad("请输入 1–4000 字的创作要求"));
    }
    if !["image", "video", "auto"].contains(&input.kind.as_str())
        || ![
            "1024x1024",
            "1536x1024",
            "1024x1536",
            "1792x1024",
            "1024x1792",
        ]
        .contains(&input.image_size.as_str())
        || !["1280x720", "720x1280"].contains(&input.video_size.as_str())
        || ![4, 8, 12].contains(&input.seconds)
    {
        return Err(AppError::bad("创作类型、尺寸或时长无效"));
    }
    let snapshot = state.for_tenant(&actor.tenant_id).await?;
    if !snapshot.config.agent_enabled || !snapshot.config.chat() {
        return Err(AppError::bad("请先启用支持工具调用的问答模型和 Pi Agent"));
    }
    let (mut settings, _) = models::load(&state, &actor.tenant_id).await?;
    settings.image = if input.kind != "video" {
        settings
            .selected_media("image", input.image_model_id.as_deref())?
            .map(|m| m.config.clone())
            .unwrap_or_default()
    } else {
        Provider::default()
    };
    settings.video = if input.kind != "image" {
        settings
            .selected_media("video", input.video_model_id.as_deref())?
            .map(|m| m.config.clone())
            .unwrap_or_default()
    } else {
        Provider::default()
    };
    if (input.kind == "image" && !settings.image.enabled)
        || (input.kind == "video" && !settings.video.enabled)
        || (!settings.image.enabled && !settings.video.enabled)
    {
        return Err(AppError::bad("请先配置并启用对应的创作模型"));
    }
    let previous = project_messages(&state, &actor, &input.project_id).await?;
    let mut history = Vec::new();
    let mut citations = Vec::new();
    for message in previous.iter().rev().take(8).rev() {
        if citations.len() + message["citations"].as_array().unwrap().len() > 12 {
            continue;
        }
        history.push(json!({"role":message["role"],"content":message["content"].as_str().unwrap_or("").chars().take(3000).collect::<String>()}));
        citations.extend(message["citations"].as_array().unwrap().iter().cloned());
    }
    state.db.exec("INSERT INTO studio_messages(id,project_id,request_id,role,content,created_at) VALUES(?,?,?,'user',?,?) ON CONFLICT(project_id,request_id,role) DO NOTHING",vec![json!(id()),json!(input.project_id),json!(input.request_id),json!(input.prompt),json!(now())]).await?;
    state
        .db
        .exec(
            "UPDATE studio_projects SET updated_at=? WHERE id=?",
            vec![json!(now()), json!(input.project_id)],
        )
        .await?;
    let result = agent::answer(
        &snapshot,
        &actor,
        agent::Input {
            query: input.prompt,
            initial: vec![],
            history,
            history_citations: citations,
            space_id: None,
            document_ids: None,
            allow_web: input.allow_web,
            bot: None,
            studio: Some(Context {
                project_id: input.project_id.clone(),
                request_id: input.request_id.clone(),
                kind: input.kind,
                image_size: input.image_size,
                video_size: input.video_size,
                seconds: input.seconds,
                settings,
            }),
        },
    )
    .await;
    let answer = match result {
        Ok(answer) => answer,
        Err(error) => {
            state.db.exec("INSERT INTO studio_messages(id,project_id,request_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?) ON CONFLICT(project_id,request_id,role) DO UPDATE SET content=excluded.content",vec![json!(id()),json!(input.project_id),json!(input.request_id),json!(format!("Agent 未完成：{}。如已有生成任务，可继续在作品区查看进度。",error.1)),json!(now()+1)]).await?;
            return Err(error);
        }
    };
    let actor = agent::current_actor(&state, &actor).await?;
    if !valid_evidence(&state, &actor, &answer.citations).await? {
        return Err(AppError::forbidden());
    }
    state.db.exec("INSERT INTO studio_messages(id,project_id,request_id,role,content,citations,web_sources,tool_calls,created_at) VALUES(?,?,?,'assistant',?,?,?,?,?) ON CONFLICT(project_id,request_id,role) DO UPDATE SET content=excluded.content,citations=excluded.citations,web_sources=excluded.web_sources,tool_calls=excluded.tool_calls",vec![json!(id()),json!(input.project_id),json!(input.request_id),json!(answer.text),json!(json!(answer.citations).to_string()),json!(json!(answer.web_sources).to_string()),json!(json!(answer.tools).to_string()),json!(now()+1)]).await?;
    Ok(Json(
        json!({"answer":answer.text,"engine":"pi-agent-core","project_id":input.project_id}),
    ))
}
pub async fn queue(
    state: &AppState,
    actor: &Actor,
    context: &Context,
    kind: &str,
    prompt: &str,
) -> Result<Value> {
    project(state, actor, &context.project_id).await?;
    if context.kind != "auto" && context.kind != kind {
        return Err(AppError::bad("工具类型与用户选择不一致"));
    }
    if prompt.trim().is_empty() || prompt.chars().count() > 4000 {
        return Err(AppError::bad("生成提示词需为 1–4000 字"));
    }
    if let Some(job) = state
        .db
        .one(
            "SELECT id,status,kind FROM studio_jobs WHERE project_id=? AND request_id=? AND kind=?",
            vec![
                json!(context.project_id),
                json!(context.request_id),
                json!(kind),
            ],
        )
        .await?
    {
        return Ok(json!({"job":job,"note":"当前请求已提交，复用原生成任务"}));
    }
    let provider = context.settings.provider(kind)?;
    if !provider.enabled || provider.model.is_empty() || provider.base_url.is_empty() {
        return Err(AppError::bad("对应创作模型未启用"));
    }
    let count=state.db.one("SELECT COUNT(*) AS count FROM studio_jobs WHERE tenant_id=? AND user_id=? AND status IN ('queued','running')",vec![json!(actor.tenant_id),json!(actor.id)]).await?.unwrap();
    if n(&count, "count") >= 6 {
        return Err(AppError(
            StatusCode::TOO_MANY_REQUESTS,
            "同时最多进行 6 个创作任务，请等待现有任务完成".into(),
        ));
    }
    let key = id();
    let payload = models::seal(
        state,
        &format!("{}:studio:{key}", actor.tenant_id),
        provider,
    )?;
    state.db.exec("INSERT INTO studio_jobs(id,project_id,tenant_id,user_id,request_id,kind,prompt,model,size,seconds,provider_payload,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,request_id,kind) DO NOTHING",vec![json!(key),json!(context.project_id),json!(actor.tenant_id),json!(actor.id),json!(context.request_id),json!(kind),json!(prompt),json!(provider.model),json!(if kind=="image"{&context.image_size}else{&context.video_size}),json!(if kind=="video"{context.seconds}else{0}),json!(payload),json!(now()),json!(now())]).await?;
    let job = state
        .db
        .one(
            "SELECT id,kind,status FROM studio_jobs WHERE project_id=? AND request_id=? AND kind=?",
            vec![
                json!(context.project_id),
                json!(context.request_id),
                json!(kind),
            ],
        )
        .await?
        .unwrap();
    audit(
        state,
        &actor.tenant_id,
        &actor.id,
        "studio.generate",
        Some(s(&job, "id")),
        json!({"kind":kind,"model":provider.model}),
    )
    .await?;
    Ok(json!({"job":job,"note":"任务已持久化并排队，作品区将自动显示进度；尚未完成生成"}))
}
pub async fn job_status(
    state: &AppState,
    actor: &Actor,
    context: &Context,
    key: &str,
) -> Result<Value> {
    project(state, actor, &context.project_id).await?;
    let job = state
        .db
        .one(
            "SELECT id,kind,status,progress,error FROM studio_jobs WHERE id=? AND project_id=?",
            vec![json!(key), json!(context.project_id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    Ok(json!(job))
}

async fn bytes(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(AppError::bad(format!(
            "生成服务返回 HTTP {}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|n| n > maximum as u64)
    {
        return Err(AppError::bad("生成文件超过大小限制"));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::bad("读取生成文件失败"))?
    {
        if data.len() + chunk.len() > maximum {
            return Err(AppError::bad("生成文件超过大小限制"));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
fn request(
    state: &AppState,
    provider: &Provider,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    let mut request = state
        .http
        .request(method, format!("{}/{path}", provider.base_url))
        .timeout(Duration::from_secs(180));
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }
    request
}
async fn image_bytes(state: &AppState, provider: &Provider, item: &Value) -> Result<Vec<u8>> {
    if let Some(encoded) = item["b64_json"].as_str() {
        return STANDARD
            .decode(encoded)
            .map_err(|_| AppError::bad("图片编码无效"));
    }
    let raw = item["url"]
        .as_str()
        .ok_or_else(|| AppError::bad("生图响应缺少图片数据"))?;
    generated_url_bytes(state, provider, raw, 20_000_000, "图片").await
}
async fn generated_url_bytes(
    state: &AppState,
    provider: &Provider,
    raw: &str,
    maximum: usize,
    label: &str,
) -> Result<Vec<u8>> {
    let url = reqwest::Url::parse(raw).map_err(|_| AppError::bad(format!("{label}地址无效")))?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::bad(format!("{label}地址无效")));
    }
    let base =
        reqwest::Url::parse(&provider.base_url).map_err(|_| AppError::bad("模型地址无效"))?;
    if url.origin() == base.origin() {
        // The administrator configured this origin; returned URLs never receive an API key.
        let response = state
            .http
            .get(url)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| AppError::bad(format!("下载生成{label}失败")))?;
        bytes(response, maximum).await
    } else {
        crate::web::download_public(raw, maximum).await
    }
}
fn media_type(kind: &str, data: &[u8]) -> Result<(&'static str, &'static str)> {
    match kind {
        "image" if data.starts_with(b"\x89PNG\r\n\x1a\n") => Ok(("image/png", "png")),
        "image" if data.starts_with(b"\xff\xd8\xff") => Ok(("image/jpeg", "jpg")),
        "image" if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") => {
            Ok(("image/webp", "webp"))
        }
        "video" if data.get(4..8) == Some(b"ftyp") => Ok(("video/mp4", "mp4")),
        "video" if data.starts_with(b"\x1a\x45\xdf\xa3") => Ok(("video/webm", "webm")),
        _ => Err(AppError::bad("生成服务未返回有效图片或视频文件")),
    }
}
async fn complete(state: &AppState, job: &Record, data: Vec<u8>) -> Result<()> {
    let kind = s(job, "kind");
    let (mime, extension) = media_type(kind, &data)?;
    let key = id();
    let storage_key = format!("{}/studio/{key}.{extension}", s(job, "tenant_id"));
    state.storage.put(&storage_key, &data).await?;
    let mut tx = state.db.pool.begin().await?;
    let changed=state.db.tx_exec(&mut tx,"UPDATE studio_jobs SET status='completed',progress=100,finished_at=?,lease_until=NULL,worker_token=NULL,provider_payload='' WHERE id=? AND worker_token=? AND lease_until>?",vec![json!(now()),job["id"].clone(),job["worker_token"].clone(),json!(now())]).await?;
    if changed != 1 {
        return Err(AppError::bad("生成任务租约已失效"));
    }
    state.db.tx_exec(&mut tx,"INSERT INTO studio_assets(id,job_id,tenant_id,user_id,kind,mime_type,storage_key,size,created_at) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(key),job["id"].clone(),job["tenant_id"].clone(),job["user_id"].clone(),json!(kind),json!(mime),json!(storage_key),json!(data.len() as i64),json!(now())]).await?;
    crate::personal::archive(state, &mut tx, job, &key, &data, mime, extension).await?;
    tx.commit().await?;
    Ok(())
}
async fn retry_video_read(state: &AppState, job: &Record) -> Result<()> {
    let failures = n(job, "poll_errors") + 1;
    if failures > 6 {
        return Err(AppError::bad(
            "视频查询或下载连续失败，请在服务商后台核对任务后重新创作",
        ));
    }
    let delay = (5000_i64 * (1 << failures.min(4))).min(60_000);
    state.db.exec("UPDATE studio_jobs SET poll_errors=?,error='视频服务暂不可用，正在重试查询或下载',available_at=?,lease_until=NULL,worker_token=NULL WHERE id=? AND worker_token=?",vec![json!(failures),json!(now()+delay),job["id"].clone(),job["worker_token"].clone()]).await?;
    Ok(())
}
fn transient(response: &reqwest::Response) -> bool {
    response.status().is_server_error() || matches!(response.status().as_u16(), 408 | 429)
}
fn grok_video(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.starts_with("grok-imagine-video") || model.starts_with("grok-video")
}
async fn step(state: &AppState, job: &Record) -> Result<()> {
    if state
        .db
        .one(
            "SELECT id FROM users WHERE id=? AND tenant_id=? AND active=1",
            vec![job["user_id"].clone(), job["tenant_id"].clone()],
        )
        .await?
        .is_none()
    {
        return Err(AppError::forbidden());
    }
    if now() - n(job, "created_at") > 45 * 60_000 {
        return Err(AppError::bad(
            "视频任务超过 45 分钟，请在服务商后台核对状态",
        ));
    }
    let provider: Provider = models::open(
        state,
        &format!("{}:studio:{}", s(job, "tenant_id"), s(job, "id")),
        s(job, "provider_payload"),
    )?;
    if s(job, "kind") == "image" {
        let response = request(
            state,
            &provider,
            reqwest::Method::POST,
            "images/generations",
        )
        .header("Idempotency-Key", s(job, "id"))
        .json(&json!({"model":provider.model,"prompt":job["prompt"],"size":job["size"],"n":1}))
        .send()
        .await
        .map_err(|_| AppError::bad("生图请求失败或超时；请先核对服务商记录，避免重复付费"))?;
        let payload = models::response_json(response, 30_000_000).await?;
        let item = payload["data"]
            .as_array()
            .and_then(|data| data.first())
            .ok_or_else(|| AppError::bad("生图响应格式无效"))?;
        let data = image_bytes(state, &provider, item).await?;
        if data.len() > 20_000_000 {
            return Err(AppError::bad("图片超过 20 MB"));
        }
        return complete(state, job, data).await;
    }
    let grok = grok_video(&provider.model);
    let provider_id = if s(job, "provider_id").is_empty() {
        let submission = if grok {
            request(
                state,
                &provider,
                reqwest::Method::POST,
                "videos/generations",
            )
            .json(&json!({
                "model": provider.model,
                "prompt": job["prompt"],
                "duration": n(job, "seconds"),
                "aspect_ratio": if s(job, "size") == "720x1280" { "9:16" } else { "16:9" },
                "resolution": "720p",
            }))
        } else {
            let form = reqwest::multipart::Form::new()
                .text("model", provider.model.clone())
                .text("prompt", s(job, "prompt").to_owned())
                .text("size", s(job, "size").to_owned())
                .text("seconds", n(job, "seconds").to_string());
            request(state, &provider, reqwest::Method::POST, "videos").multipart(form)
        };
        let response = submission
            .header("Idempotency-Key", s(job, "id"))
            .send()
            .await
            .map_err(|_| AppError::bad("视频提交失败或超时；请先核对服务商记录，避免重复付费"))?;
        let payload = models::response_json(response, 1_000_000).await?;
        let key = if grok {
            payload["request_id"]
                .as_str()
                .or_else(|| payload["id"].as_str())
        } else {
            payload["id"].as_str()
        }
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .ok_or_else(|| AppError::bad("视频任务响应缺少有效 ID"))?
        .to_owned();
        state
            .db
            .exec(
                "UPDATE studio_jobs SET provider_id=? WHERE id=? AND worker_token=?",
                vec![json!(key), job["id"].clone(), job["worker_token"].clone()],
            )
            .await?;
        key
    } else {
        s(job, "provider_id").to_owned()
    };
    let response = match request(
        state,
        &provider,
        reqwest::Method::GET,
        &format!("videos/{provider_id}"),
    )
    .send()
    .await
    {
        Ok(response) if !transient(&response) => response,
        _ => return retry_video_read(state, job).await,
    };
    let payload = models::response_json(response, 1_000_000).await?;
    match payload["status"].as_str() {
        Some("completed" | "succeeded" | "done") => {
            let response = match request(
                state,
                &provider,
                reqwest::Method::GET,
                &format!("videos/{provider_id}/content"),
            )
            .send()
            .await
            {
                Ok(response) if !transient(&response) => response,
                _ => return retry_video_read(state, job).await,
            };
            // Sub2API proxies /content; the native xAI API returns a video URL instead.
            if grok
                && matches!(response.status().as_u16(), 404 | 405)
                && payload["video"]["url"].as_str().is_some()
            {
                let data = generated_url_bytes(
                    state,
                    &provider,
                    payload["video"]["url"].as_str().unwrap(),
                    200_000_000,
                    "视频",
                )
                .await?;
                complete(state, job, data).await
            } else {
                complete(state, job, bytes(response, 200_000_000).await?).await
            }
        }
        Some("queued" | "in_progress" | "processing" | "running" | "pending") => {
            state.db.exec("UPDATE studio_jobs SET progress=?,available_at=?,lease_until=NULL,worker_token=NULL,error=NULL,poll_errors=0,poll_count=poll_count+1 WHERE id=? AND worker_token=?",vec![json!(payload["progress"].as_u64().unwrap_or(0).min(99) as i64),json!(now()+5000),job["id"].clone(),job["worker_token"].clone()]).await?;
            Ok(())
        }
        Some("failed" | "cancelled" | "canceled" | "expired") => Err(AppError::bad(
            "服务商视频生成失败，请核对模型、提示词和额度后重新创作",
        )),
        _ => Err(AppError::bad(
            "视频任务状态格式不兼容，请核对服务商视频接口",
        )),
    }
}
pub async fn run_one(state: &AppState) -> anyhow::Result<bool> {
    let clock = now();
    let token = id();
    // An interrupted submission without a provider ID has an uncertain billing outcome.
    // Never silently submit it again, including after a process restart.
    state.db.exec("UPDATE studio_jobs SET status='failed',error='任务提交结果不确定，请先核对服务商记录再重新创作',provider_payload='',finished_at=? WHERE status='running' AND provider_id IS NULL AND lease_until<?",vec![json!(clock),json!(clock)]).await?;
    let job=state.db.one("UPDATE studio_jobs SET status='running',worker_token=?,lease_until=?,started_at=COALESCE(started_at,?) WHERE id=(SELECT id FROM studio_jobs WHERE status IN ('queued','running') AND available_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY created_at LIMIT 1) AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until<?) RETURNING *",vec![json!(token),json!(clock+300_000),json!(clock),json!(clock),json!(clock),json!(clock)]).await?;
    let Some(job) = job else { return Ok(false) };
    if let Err(error) = step(state, &job).await {
        state.db.exec("UPDATE studio_jobs SET status='failed',error=?,finished_at=?,lease_until=NULL,worker_token=NULL,provider_payload='' WHERE id=? AND worker_token=?",vec![json!(error.1),json!(now()),job["id"].clone(),json!(token)]).await?;
    }
    Ok(true)
}
pub async fn worker(state: AppState) {
    loop {
        match run_one(&state).await {
            Ok(true) => {}
            Ok(false) => tokio::time::sleep(Duration::from_secs(2)).await,
            Err(_) => {
                tracing::warn!("Studio worker could not update a job");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}
pub async fn asset(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    actor.browser()?;
    let asset = state
        .db
        .one(
            "SELECT * FROM studio_assets WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)?;
    let data = state.storage.get(s(&asset, "storage_key")).await?;
    let length = data.len();
    if length == 0 {
        return Err(AppError::missing());
    }
    let mut status = StatusCode::OK;
    let mut start = 0;
    let mut end = length.saturating_sub(1);
    if let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let parsed = range
            .strip_prefix("bytes=")
            .and_then(|v| v.split_once('-'))
            .filter(|(_, right)| !right.contains(','));
        if let Some((left, right)) = parsed {
            if left.is_empty() {
                let suffix = right.parse::<usize>().unwrap_or(0);
                start = length.saturating_sub(suffix);
            } else {
                start = left.parse::<usize>().unwrap_or(length);
                end = if right.is_empty() {
                    end
                } else {
                    right.parse::<usize>().unwrap_or(0).min(end)
                };
            }
            if start <= end && start < length {
                status = StatusCode::PARTIAL_CONTENT;
            } else {
                return Ok(Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .body(Body::empty())
                    .unwrap());
            }
        } else {
            return Err(AppError::bad("文件范围请求无效"));
        }
    }
    let mut response = Response::new(Body::from(data[start..=end].to_vec()));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(s(&asset, "mime_type")).unwrap(),
    );
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&(end - start + 1).to_string()).unwrap(),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{length}")).unwrap(),
        );
    }
    Ok(response)
}
