//! Private Wiki / CodeGraph assets backed by the real MemoryKnowledge v3 API.
//! Document permissions and versions are checked before both ingestion and recall.
use crate::{
    auth::{audit, Actor},
    bot::Context,
    db::{id, n, now, s, Record},
    documents,
    error::{AppError, Result},
    memory_provider, AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

const MAX_DOCUMENTS: usize = 20;
const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const FILE_BYTES: usize = 450 * 1024;
const LEASE_MS: i64 = 600_000;

fn configured(state: &AppState) -> Result<()> {
    if memory_provider::configured_knowledge(state) {
        Ok(())
    } else {
        Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Wiki / CodeGraph 服务尚未配置，请管理员设置 MEMORY_KNOWLEDGE_URL 和访问令牌后重试"
                .into(),
        ))
    }
}
fn decode(row: &Record, field: &str, fallback: Value) -> Value {
    serde_json::from_str(s(row, field)).unwrap_or(fallback)
}
fn render(row: &Record) -> Value {
    json!({"id":row["id"],"kind":row["kind"],"name":row["name"],"status":row["status"],
        "document_ids":decode(row,"document_ids",json!([])),"repository_url":row["repository_url"],
        "metadata":decode(row,"metadata",json!({})),"error":row["error"],
        "created_at":row["created_at"],"updated_at":row["updated_at"]})
}
pub async fn owned(state: &AppState, actor: &Actor, key: &str) -> Result<Record> {
    actor.browser()?;
    state.db.one("SELECT * FROM bot_knowledge_assets WHERE id=? AND tenant_id=? AND user_id=? AND deleted=0",
        vec![json!(key),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)
}
pub async fn list(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let rows=state.db.rows("SELECT * FROM bot_knowledge_assets WHERE tenant_id=? AND user_id=? AND deleted=0 ORDER BY updated_at DESC LIMIT 100",
        vec![json!(actor.tenant_id),json!(actor.id)]).await?;
    Ok(Json(
        json!({"items":rows.iter().map(render).collect::<Vec<_>>()}),
    ))
}
pub async fn get(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(render(&owned(&state, &actor, &key).await?)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub document_ids: Vec<String>,
    #[serde(default)]
    pub repository_url: String,
}
/// Only a canonical public HTTPS GitHub repository is accepted. No credentials,
/// alternate hosts, IP addresses, query strings or arbitrary source URLs.
fn repository_url(raw: &str) -> Result<String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| AppError::bad("仓库地址无效"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::bad(
            "CodeGraph 首期仅支持无凭据的公开 HTTPS GitHub 仓库",
        ));
    }
    let path = url.path().trim_end_matches('/');
    let segments: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if segments.len() != 2
        || segments.iter().any(|v| {
            v.is_empty()
                || v.starts_with('.')
                || !v
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        })
    {
        return Err(AppError::bad(
            "请填写 https://github.com/组织/仓库 的完整仓库地址",
        ));
    }
    let repo = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if repo.is_empty() {
        return Err(AppError::bad("仓库地址无效"));
    }
    Ok(format!("https://github.com/{}/{repo}.git", segments[0]))
}
async fn public_repository(state: &AppState, raw: &str) -> Result<String> {
    let canonical = repository_url(raw)?;
    let path = canonical
        .strip_prefix("https://github.com/")
        .unwrap()
        .strip_suffix(".git")
        .unwrap();
    let response = state
        .http
        .get(format!("https://api.github.com/repos/{path}"))
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "Zhixiaohui-Knowledge")
        .send()
        .await
        .map_err(|_| {
            AppError(
                StatusCode::BAD_GATEWAY,
                "无法验证公开仓库，请稍后重试".into(),
            )
        })?;
    if !response.status().is_success() {
        return Err(AppError::bad(
            "仓库必须公开且可访问；请使用仓库当前的 GitHub 地址",
        ));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| AppError::bad("GitHub 仓库信息无效"))?;
    if data["private"].as_bool() != Some(false)
        || data["clone_url"]
            .as_str()
            .and_then(|v| repository_url(v).ok())
            .as_deref()
            != Some(canonical.as_str())
    {
        return Err(AppError::bad("仅支持当前地址对应的公开 GitHub 仓库"));
    }
    let branch = data["default_branch"].as_str().unwrap_or("");
    if branch.is_empty() || branch.len() > 200 || branch.starts_with('-') || branch.contains('\0') {
        return Err(AppError::bad("仓库默认分支无效"));
    }
    Ok(branch.to_owned())
}
async fn recall_public_repository(state: &AppState, raw: &str) -> Result<()> {
    // Repeated read tools in one task share a 30s publicness check. Build/sync
    // always performs a fresh check, and failed validations are never cached.
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, i64>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let canonical = repository_url(raw)?;
    if cache
        .lock()
        .await
        .get(&canonical)
        .is_some_and(|checked| now() - checked < 30_000)
    {
        return Ok(());
    }
    public_repository(state, &canonical).await?;
    let mut entries = cache.lock().await;
    if entries.len() >= 1000 {
        entries.retain(|_, checked| now() - *checked < 30_000);
    }
    if entries.len() < 1000 {
        entries.insert(canonical, now());
    }
    Ok(())
}

/// Snapshot only already parsed current chunks; never fetch document source URLs.
async fn sources(
    state: &AppState,
    actor: &Actor,
    keys: &[String],
    content: bool,
) -> Result<(Value, Vec<Value>)> {
    if keys.is_empty()
        || keys.len() > MAX_DOCUMENTS
        || keys.iter().collect::<HashSet<_>>().len() != keys.len()
    {
        return Err(AppError::bad("Wiki 需要选择 1 至 20 份不同的已解析资料"));
    }
    let mut snapshot = vec![];
    let mut files = vec![];
    let mut total = 0usize;
    for key in keys {
        let doc = documents::accessible(state, actor, key).await?;
        if s(&doc, "status") != "ready" || n(&doc, "indexed_version") != n(&doc, "version") {
            return Err(AppError(
                StatusCode::CONFLICT,
                "所选资料尚未完成当前版本解析，请稍后重试".into(),
            ));
        }
        snapshot
            .push(json!({"document_id":key,"version":n(&doc,"version"),"title":s(&doc,"title")}));
        if !content {
            continue;
        }
        let chunks=state.db.rows("SELECT text,page FROM chunks WHERE tenant_id=? AND document_id=? AND version=? ORDER BY position",
            vec![json!(actor.tenant_id),json!(key),json!(n(&doc,"version"))]).await?;
        if chunks.is_empty() {
            return Err(AppError::bad("所选资料没有可读取的解析文本"));
        }
        let mut text = format!(
            "# {}\n\n来源: 知小汇文档 {}，版本 {}\n\n",
            s(&doc, "title"),
            key,
            n(&doc, "version")
        );
        for chunk in chunks {
            text.push_str(&format!(
                "\n<!-- page {} -->\n{}\n",
                n(&chunk, "page"),
                s(&chunk, "text")
            ));
            if text.len() + total > MAX_SOURCE_BYTES {
                return Err(AppError::bad(
                    "所选 Wiki 资料文本合计不能超过 4 MB，请减少资料数量",
                ));
            }
        }
        total += text.len();
        let mut start = 0;
        let mut part = 0;
        while start < text.len() {
            let mut end = (start + FILE_BYTES).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            // Filenames contain only server generated document hashes, not user paths.
            files.push(json!({"filename":format!("{}-{part}.md",crate::auth::hash(key)),"content":&text[start..end]}));
            start = end;
            part += 1;
        }
    }
    Ok((json!(snapshot), files))
}
fn document_keys(row: &Record) -> Result<Vec<String>> {
    serde_json::from_str(s(row, "document_ids")).map_err(|_| AppError::bad("知识资料选择无效"))
}
async fn current_sources(state: &AppState, actor: &Actor, row: &Record) -> Result<Value> {
    if s(row, "kind") != "wiki" {
        return Ok(json!([]));
    }
    let (current, _) = sources(state, actor, &document_keys(row)?, false).await?;
    // Titles can change without changing source content. Versions are the recall boundary.
    let previous = decode(row, "source_snapshot", json!([]));
    let fingerprint = |data: &Value| {
        data.as_array().map(|rows| {
            rows.iter()
                .map(|v| {
                    (
                        v["document_id"].as_str().unwrap_or("").to_owned(),
                        v["version"].as_i64().unwrap_or(0),
                    )
                })
                .collect::<Vec<_>>()
        })
    };
    if fingerprint(&current) != fingerprint(&previous) {
        return Err(AppError(
            StatusCode::CONFLICT,
            "Wiki 的来源版本已更新，请先同步后再检索".into(),
        ));
    }
    Ok(current)
}
pub async fn create(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<CreateInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    configured(&state)?;
    let name = crate::org::label(&input.name, 120)?;
    let repository = match input.kind.as_str() {
        "wiki" => {
            if !input.repository_url.is_empty() {
                return Err(AppError::bad("Wiki 只能使用所选授权资料"));
            }
            sources(&state, &actor, &input.document_ids, true).await?;
            String::new()
        }
        "code_graph" => {
            if !input.document_ids.is_empty() {
                return Err(AppError::bad("CodeGraph 不接受文档来源"));
            }
            repository_url(&input.repository_url)?
        }
        _ => return Err(AppError::bad("知识类型必须是 wiki 或 code_graph")),
    };
    let key = id();
    let time = now();
    let mut tx = state.db.pool.begin().await?;
    if state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE users SET active=active WHERE id=? AND tenant_id=? AND active=1",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        == 0
    {
        return Err(AppError::unauthorized());
    }
    if input.kind=="code_graph" && state.db.tx_one(&mut tx,"SELECT id FROM bot_knowledge_assets WHERE tenant_id=? AND user_id=? AND kind='code_graph' AND lower(repository_url)=lower(?) AND status!='deleted'",vec![json!(actor.tenant_id),json!(actor.id),json!(repository)]).await?.is_some() {
        return Err(AppError(StatusCode::CONFLICT,"此仓库已经添加；请使用现有资产或等待删除清理完成".into()));
    }
    let total=state.db.tx_one(&mut tx,"SELECT COUNT(*) AS total FROM bot_knowledge_assets WHERE tenant_id=? AND user_id=? AND deleted=0",vec![json!(actor.tenant_id),json!(actor.id)]).await?.unwrap();
    if n(&total, "total") >= 100 {
        return Err(AppError::bad("最多创建 100 个知识资产，请先删除旧资产"));
    }
    state.db.tx_exec(&mut tx,"INSERT INTO bot_knowledge_assets(id,tenant_id,user_id,kind,name,document_ids,repository_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(input.kind),json!(name),json!(json!(input.document_ids).to_string()),json!(repository),json!(time),json!(time)]).await?;
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "bot.knowledge.create",
        Some(&key),
        json!({"kind":input.kind}),
    )
    .await?;
    Ok(Json(render(&owned(&state, &actor, &key).await?)))
}
pub async fn sync(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    configured(&state)?;
    let row = owned(&state, &actor, &key).await?;
    if s(&row, "kind") == "wiki" {
        sources(&state, &actor, &document_keys(&row)?, true).await?;
    }
    let changed=state.db.exec("UPDATE bot_knowledge_assets SET status='queued',error='',attempts=0,available_at=0,updated_at=? WHERE id=? AND deleted=0 AND lease_until<=? AND status NOT IN ('queued','building')",
        vec![json!(now()),json!(key),json!(now())]).await?;
    if changed == 0 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "知识资产正在构建或同步，请等待完成".into(),
        ));
    }
    Ok(Json(render(&owned(&state, &actor, &key).await?)))
}
pub async fn delete(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    owned(&state, &actor, &key).await?;
    // Tombstone immediately; remote cleanup remains durable if the provider is down.
    state.db.exec("UPDATE bot_knowledge_assets SET deleted=1,status='deleting',available_at=0,error='',updated_at=? WHERE id=? AND tenant_id=? AND user_id=?",
        vec![json!(now()),json!(key),json!(actor.tenant_id),json!(actor.id)]).await?;
    Ok(Json(json!({"ok":true,"status":"deleting"})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchInput {
    pub query: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolInput {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}
fn parameter_text(args: &Map<String, Value>, name: &str, max: usize) -> Result<String> {
    let value = args.get(name).and_then(Value::as_str).unwrap_or("").trim();
    if value.is_empty() || value.len() > max || value.contains('\0') {
        return Err(AppError::bad(format!("{name} 参数无效或过长")));
    }
    Ok(value.into())
}
fn params(kind: &str, action: &str, args: &Value) -> Result<Value> {
    let args = args
        .as_object()
        .ok_or_else(|| AppError::bad("arguments 必须是对象"))?;
    let allowed: &[&str] = match (kind, action) {
        (_, "search") => &["query", "limit", "kind"],
        ("wiki", "read_page") => &["refs"],
        ("wiki", "list_pages" | "get_graph") => &[],
        ("code_graph", "explore") => &["query", "maxFiles"],
        ("code_graph", "callers" | "callees") => &["symbol", "limit"],
        ("code_graph", "impact") => &["symbol", "depth"],
        ("code_graph", "node") => &["symbol", "includeCode", "file", "line"],
        ("code_graph", "files") => &["path", "pattern", "format"],
        _ => return Err(AppError::bad("仅支持知识资产的只读检索工具")),
    };
    if args.keys().any(|v| !allowed.contains(&v.as_str())) {
        return Err(AppError::bad("工具包含未授权参数"));
    }
    let mut out = args.clone();
    for key in ["query", "symbol"] {
        if allowed.contains(&key) {
            out.insert(key.into(), json!(parameter_text(args, key, 2000)?));
        }
    }
    if action == "read_page" {
        let refs = args
            .get("refs")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::bad("refs 需要页面引用数组"))?;
        if refs.is_empty()
            || refs.len() > 10
            || refs.iter().any(|v| {
                v.as_str().is_none_or(|r| {
                    r.is_empty()
                        || r.len() > 500
                        || r.contains('\0')
                        || r.contains("..")
                        || r.starts_with('/')
                })
            })
        {
            return Err(AppError::bad("页面引用无效或过多"));
        }
    }
    for (key, max) in [
        ("limit", 50),
        ("maxFiles", 20),
        ("depth", 5),
        ("line", 1_000_000),
    ] {
        if let Some(value) = args.get(key) {
            if value.as_i64().is_none_or(|v| v < 1 || v > max) {
                return Err(AppError::bad(format!("{key} 超出允许范围")));
            }
        }
    }
    for key in ["file", "path", "pattern"] {
        if let Some(v) = args.get(key) {
            if v.as_str().is_none_or(|v| {
                v.len() > 500 || v.contains('\0') || v.contains("..") || v.starts_with('/')
            }) {
                return Err(AppError::bad("代码路径参数无效"));
            }
        }
    }
    if args.get("includeCode").is_some_and(|v| !v.is_boolean()) {
        return Err(AppError::bad("includeCode 必须为布尔值"));
    }
    if let Some(v) = args.get("kind") {
        if kind != "code_graph"
            || ![
                "function",
                "method",
                "class",
                "interface",
                "type",
                "variable",
                "route",
                "component",
            ]
            .contains(&v.as_str().unwrap_or(""))
        {
            return Err(AppError::bad("符号类型无效"));
        }
    }
    if args
        .get("format")
        .is_some_and(|v| !["tree", "flat", "grouped"].contains(&v.as_str().unwrap_or("")))
    {
        return Err(AppError::bad("文件树格式无效"));
    }
    if action == "node" {
        out.insert("includeCode".into(), json!(true));
    }
    Ok(Value::Object(out))
}
async fn call(
    state: &AppState,
    actor: &Actor,
    row: &Record,
    name: &str,
    args: Value,
) -> Result<Value> {
    configured(state)?;
    if s(row, "status") != "ready" || s(row, "provider_id").is_empty() {
        return Err(AppError(
            StatusCode::CONFLICT,
            "知识资产尚未构建完成，请稍后重试".into(),
        ));
    }
    let sources = current_sources(state, actor, row).await?;
    if s(row, "kind") == "code_graph" {
        recall_public_repository(state, s(row, "repository_url")).await?;
    }
    let arguments = params(s(row, "kind"), name, &args)?;
    let result=memory_provider::post_knowledge(state,actor,"/v3/tools/call",json!({"knowledge_id":s(row,"provider_id"),"tool_name":name,"params":arguments,"asset_scope":s(row,"id")})).await?;
    // Revocation or replacement during a provider call must not release derived content.
    let fresh = owned(state, actor, s(row, "id")).await?;
    if s(&fresh, "provider_id") != s(row, "provider_id") || s(&fresh, "status") != "ready" {
        return Err(AppError(
            StatusCode::CONFLICT,
            "知识资产已变更，请重试".into(),
        ));
    }
    current_sources(state, actor, &fresh).await?;
    audit(
        state,
        &actor.tenant_id,
        &actor.id,
        "bot.knowledge.read",
        Some(s(row, "id")),
        json!({"tool":name}),
    )
    .await?;
    Ok(
        json!({"asset_id":row["id"],"kind":row["kind"],"result":result,"sources":sources,"repository_url":row["repository_url"]}),
    )
}
pub async fn search(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<SearchInput>,
) -> Result<Json<Value>> {
    let row = owned(&state, &actor, &key).await?;
    Ok(Json(
        call(
            &state,
            &actor,
            &row,
            "search",
            json!({"query":input.query,"limit":20}),
        )
        .await?,
    ))
}
pub async fn tools(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
    Json(input): Json<ToolInput>,
) -> Result<Json<Value>> {
    let row = owned(&state, &actor, &key).await?;
    Ok(Json(
        call(&state, &actor, &row, &input.name, input.arguments).await?,
    ))
}
pub async fn validate_selection(state: &AppState, actor: &Actor, keys: &[String]) -> Result<()> {
    if keys.len() > 20 || keys.iter().collect::<HashSet<_>>().len() != keys.len() {
        return Err(AppError::bad("最多选择 20 个不同知识资产"));
    }
    for key in keys {
        let row = owned(state, actor, key).await?;
        if s(&row, "status") != "ready" || s(&row, "provider_id").is_empty() {
            return Err(AppError(
                StatusCode::CONFLICT,
                "所选知识资产尚未就绪，请等待构建或同步完成".into(),
            ));
        }
        current_sources(state, actor, &row).await?;
    }
    Ok(())
}
pub async fn tool(
    state: &AppState,
    actor: &Actor,
    context: &Context,
    name: &str,
    args: Value,
) -> Result<Value> {
    let key = args["asset_id"]
        .as_str()
        .ok_or_else(|| AppError::bad("asset_id 必填"))?;
    if !context.options.knowledge_asset_ids.iter().any(|v| v == key) {
        return Err(AppError::forbidden());
    }
    let (kind, action) = match name {
        "wiki_search" => ("wiki", "search"),
        "wiki_read" => ("wiki", "read_page"),
        "code_graph_search" => ("code_graph", "search"),
        "code_graph_callers" => ("code_graph", "callers"),
        "code_graph_callees" => ("code_graph", "callees"),
        "code_graph_impact" => ("code_graph", "impact"),
        "code_graph_read" => ("code_graph", "explore"),
        _ => return Err(AppError::bad("未知知识工具")),
    };
    let row = owned(state, actor, key).await?;
    if s(&row, "kind") != kind {
        return Err(AppError::bad("知识资产类型与工具不匹配"));
    }
    let mut args = args
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::bad("工具参数必须是对象"))?;
    args.remove("asset_id");
    call(state, actor, &row, action, Value::Object(args)).await
}

async fn owner(state: &AppState, row: &Record) -> Result<Actor> {
    let user = state
        .db
        .one(
            "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
            vec![row["user_id"].clone(), row["tenant_id"].clone()],
        )
        .await?
        .ok_or_else(AppError::unauthorized)?;
    Ok(Actor {
        id: s(&user, "id").into(),
        tenant_id: s(&user, "tenant_id").into(),
        department_id: s(&user, "department_id").into(),
        role: s(&user, "role").into(),
        scopes: None,
        key_id: None,
    })
}
fn metadata(data: &Value) -> Value {
    let mut out = Map::new();
    for key in [
        "page_count",
        "stats",
        "commit_hash",
        "branch",
        "version",
        "last_sync_at",
    ] {
        if let Some(value) = data.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}
async fn provider(
    state: &AppState,
    actor: &Actor,
    row: &Record,
    path: &str,
    mut payload: Value,
) -> Result<Value> {
    payload["asset_scope"] = row["id"].clone();
    memory_provider::post_knowledge(state, actor, &format!("/v3{path}"), payload).await
}
async fn purge(state: &AppState, actor: &Actor, row: &Record) -> Result<()> {
    let key = s(row, "provider_id");
    if key.is_empty() {
        if n(row, "create_uncertain") != 1 {
            return Ok(());
        }
        let wiki = s(row, "kind") == "wiki";
        let path = if wiki {
            "/wiki/list"
        } else {
            "/code-graph/list"
        };
        let expected_team = memory_provider::identity(actor, true)["team_id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        for page in 0..10 {
            let response = provider(
                state,
                actor,
                row,
                path,
                json!({"limit":100,"offset":page*100}),
            )
            .await?;
            let items = response["items"]
                .as_array()
                .ok_or_else(|| AppError(StatusCode::BAD_GATEWAY, "无法核验远端创建结果".into()))?;
            for item in items {
                if item["team_id"].as_str() != Some(expected_team.as_str()) {
                    continue;
                }
                let matches = if wiki {
                    item["name"].as_str() == Some(format!("zhx-{}", s(row, "id")).as_str())
                } else {
                    item["repo_url"]
                        .as_str()
                        .and_then(|v| repository_url(v).ok())
                        .is_some_and(|v| v.eq_ignore_ascii_case(s(row, "repository_url")))
                        && item["branch"].as_str() == Some(s(row, "create_branch"))
                };
                if !matches {
                    continue;
                }
                let field = if wiki { "wiki_id" } else { "code_graph_id" };
                let remote = item[field]
                    .as_str()
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() < 200
                            && v.bytes()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                    })
                    .ok_or_else(|| AppError(StatusCode::BAD_GATEWAY, "远端资源标识无效".into()))?;
                // Keep the recovered ID durably before attempting deletion.
                state.db.exec("UPDATE bot_knowledge_assets SET provider_id=? WHERE id=? AND lease_token=?",vec![json!(remote),row["id"].clone(),row["lease_token"].clone()]).await?;
                let mut recovered = row.clone();
                recovered.insert("provider_id".into(), json!(remote));
                Box::pin(purge(state, actor, &recovered)).await?;
                state.db.exec("UPDATE bot_knowledge_assets SET create_uncertain=0 WHERE id=? AND lease_token=?",vec![row["id"].clone(),row["lease_token"].clone()]).await?;
                return Ok(());
            }
            if items.len() < 100 {
                break;
            }
        }
        // A timed-out create can still finish later. An empty list is not an
        // acknowledgement that no resource was created; retain the receipt.
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "远端创建结果尚未确认，清理等待自动核验".into(),
        ));
    }
    let (path, payload) = if s(row, "kind") == "wiki" {
        ("/wiki/delete", json!({"wiki_ids":[key]}))
    } else {
        ("/code-graph/delete", json!({"code_graph_ids":[key]}))
    };
    let result = provider(state, actor, row, path, payload).await?;
    let deleted = result["deleted_ids"]
        .as_array()
        .is_some_and(|v| v.iter().any(|v| v.as_str() == Some(key)));
    let missing = result["failed"].as_array().is_some_and(|v| {
        v.iter()
            .any(|v| v["id"].as_str() == Some(key) && v["reason"].as_str() == Some("not found"))
    });
    if !deleted && !missing {
        return Err(AppError(
            StatusCode::BAD_GATEWAY,
            "远端知识资产尚未清理，将自动重试".into(),
        ));
    }
    Ok(())
}
async fn live(state: &AppState, row: &Record) -> Result<()> {
    if state
        .db
        .one(
            "SELECT id FROM bot_knowledge_assets WHERE id=? AND deleted=0 AND lease_token=?",
            vec![row["id"].clone(), row["lease_token"].clone()],
        )
        .await?
        .is_none()
    {
        return Err(AppError::missing());
    }
    Ok(())
}
async fn process(state: &AppState, row: &Record) -> Result<()> {
    // Cleanup is permitted even after an account was disabled.
    let actor = if n(row, "deleted") == 1 {
        Actor {
            id: s(row, "user_id").into(),
            tenant_id: s(row, "tenant_id").into(),
            department_id: String::new(),
            role: "member".into(),
            scopes: None,
            key_id: None,
        }
    } else {
        owner(state, row).await?
    };
    if n(row, "deleted") == 1 {
        purge(state, &actor, row).await?;
        state.db.exec("UPDATE bot_knowledge_assets SET status='deleted',provider_id='',create_uncertain=0,source_snapshot='[]',metadata='{}',lease_until=0,lease_token='',error='',updated_at=? WHERE id=? AND lease_token=?",
            vec![json!(now()),row["id"].clone(),row["lease_token"].clone()]).await?;
        return Ok(());
    }
    let kind = s(row, "kind");
    if s(row, "status") == "queued" {
        let (snapshot, files) = if kind == "wiki" {
            sources(state, &actor, &document_keys(row)?, true).await?
        } else {
            (json!([]), vec![])
        };
        let branch = if kind == "code_graph" {
            public_repository(state, s(row, "repository_url")).await?
        } else {
            String::new()
        };
        if kind == "code_graph"
            && !s(row, "provider_id").is_empty()
            && decode(row, "metadata", json!({}))["branch"].as_str() == Some(branch.as_str())
        {
            live(state, row).await?;
            provider(
                state,
                &actor,
                row,
                "/code-graph/sync",
                json!({"code_graph_id":s(row,"provider_id")}),
            )
            .await?;
            state.db.exec("UPDATE bot_knowledge_assets SET status='building',available_at=?,attempts=0,error='',lease_until=0,lease_token='',updated_at=? WHERE id=? AND lease_token=? AND deleted=0",
                vec![json!(now()+2000),json!(now()),row["id"].clone(),row["lease_token"].clone()]).await?;
            return Ok(());
        }
        // Recreate wiki so removed/changed raw pages cannot persist across sync.
        purge(state, &actor, row).await?;
        state.db.exec("UPDATE bot_knowledge_assets SET provider_id='',metadata='{}' WHERE id=? AND lease_token=?",vec![row["id"].clone(),row["lease_token"].clone()]).await?;
        live(state, row).await?;
        let payload = if kind == "wiki" {
            json!({"name":format!("zhx-{}",s(row,"id"))})
        } else {
            json!({"repo_url":s(row,"repository_url"),"repo_name":s(row,"name"),"branch":branch})
        };
        let path = if kind == "wiki" {
            "/wiki/create"
        } else {
            "/code-graph/create"
        };
        state.db.exec("UPDATE bot_knowledge_assets SET create_uncertain=1,create_branch=? WHERE id=? AND lease_token=?",vec![json!(branch),row["id"].clone(),row["lease_token"].clone()]).await?;
        let result = provider(state, &actor, row, path, payload).await?;
        let field = if kind == "wiki" {
            "wiki_id"
        } else {
            "code_graph_id"
        };
        let key = result[field]
            .as_str()
            .filter(|v| {
                !v.is_empty()
                    && v.len() < 200
                    && v.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            })
            .ok_or_else(|| {
                AppError(
                    StatusCode::BAD_GATEWAY,
                    "知识服务没有返回有效资源标识".into(),
                )
            })?;
        // Persist even if delete raced create: the tombstone worker must know what to purge.
        state.db.exec("UPDATE bot_knowledge_assets SET provider_id=?,create_uncertain=0,source_snapshot=?,metadata=? WHERE id=? AND lease_token=?",
            vec![json!(key),json!(snapshot.to_string()),json!(metadata(&result).to_string()),row["id"].clone(),row["lease_token"].clone()]).await?;
        live(state, row).await?;
        if kind == "wiki" {
            let mut built = row.clone();
            built.insert("source_snapshot".into(), json!(snapshot.to_string()));
            for batch in files.chunks(2) {
                live(state, row).await?;
                // Recheck ACL immediately before each outbound source transfer.
                current_sources(state, &actor, &built).await?;
                provider(
                    state,
                    &actor,
                    row,
                    "/wiki/raw/write",
                    json!({"wiki_id":key,"files":batch}),
                )
                .await?;
            }
            live(state, row).await?;
            current_sources(state, &actor, &built).await?;
            provider(state, &actor, row, "/wiki/ingest", json!({"wiki_id":key})).await?;
        }
        state.db.exec("UPDATE bot_knowledge_assets SET status='building',available_at=?,attempts=0,error='',lease_until=0,lease_token='',updated_at=? WHERE id=? AND lease_token=? AND deleted=0",
            vec![json!(now()+2000),json!(now()),row["id"].clone(),row["lease_token"].clone()]).await?;
    } else {
        current_sources(state, &actor, row).await?;
        let (path, field) = if kind == "wiki" {
            ("/wiki/get", "wiki_id")
        } else {
            ("/code-graph/get", "code_graph_id")
        };
        let result = provider(
            state,
            &actor,
            row,
            path,
            json!({(field):s(row,"provider_id")}),
        )
        .await?;
        let status = result["status"].as_str().unwrap_or("");
        let mapped = match status {
            "ready" => "ready",
            "failed" | "error" => "failed",
            "pending" | "processing" => "building",
            _ => {
                return Err(AppError(
                    StatusCode::BAD_GATEWAY,
                    "知识服务返回了未知构建状态".into(),
                ))
            }
        };
        current_sources(state, &actor, row).await?;
        state.db.exec("UPDATE bot_knowledge_assets SET status=?,metadata=?,error=?,attempts=0,available_at=?,lease_until=0,lease_token='',updated_at=? WHERE id=? AND lease_token=? AND deleted=0",
            vec![json!(mapped),json!(metadata(&result).to_string()),json!(if mapped=="failed" {"知识服务构建失败，请查看服务日志后重新同步"} else {""}),json!(now()+5000),json!(now()),row["id"].clone(),row["lease_token"].clone()]).await?;
    }
    Ok(())
}
/// Claim one durable job. API and standalone workers may safely share the queue.
pub async fn tick(state: &AppState) -> Result<bool> {
    if !memory_provider::configured_knowledge(state) {
        return Ok(false);
    }
    let mut tx = state.db.pool.begin().await?;
    let row=state.db.tx_one(&mut tx,"SELECT * FROM bot_knowledge_assets WHERE status IN ('queued','building','deleting') AND available_at<=? AND lease_until<=? ORDER BY available_at,created_at LIMIT 1",
        vec![json!(now()),json!(now())]).await?;
    let Some(mut row) = row else {
        return Ok(false);
    };
    let token = id();
    let changed=state.db.tx_exec(&mut tx,"UPDATE bot_knowledge_assets SET lease_until=?,lease_token=? WHERE id=? AND lease_until<=? AND status IN ('queued','building','deleting')",
        vec![json!(now()+LEASE_MS),json!(token),row["id"].clone(),json!(now())]).await?;
    tx.commit().await?;
    if changed == 0 {
        return Ok(false);
    }
    row.insert("lease_token".into(), json!(token));
    let processing = process(state, &row);
    tokio::pin!(processing);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
    heartbeat.tick().await;
    let outcome = loop {
        tokio::select! {
            result = &mut processing => break result,
            _ = heartbeat.tick() => {
                let changed = state.db.exec("UPDATE bot_knowledge_assets SET lease_until=? WHERE id=? AND lease_token=? AND status IN ('queued','building','deleting')",
                    vec![json!(now()+LEASE_MS),row["id"].clone(),json!(token)]).await?;
                if changed == 0 {
                    // Dropping the future aborts outbound work after a lost lease.
                    // The new lease holder owns reconciliation and cleanup.
                    return Ok(true);
                }
            }
        }
    };
    if let Err(error) = outcome {
        tracing::warn!(asset_id=s(&row,"id"),status=%error.0,"knowledge job failed");
        let attempts = n(&row, "attempts") + 1;
        let current = state
            .db
            .one(
                "SELECT deleted,create_uncertain,provider_id FROM bot_knowledge_assets WHERE id=?",
                vec![row["id"].clone()],
            )
            .await?;
        let deleted = current.as_ref().is_some_and(|v| n(v, "deleted") == 1);
        let uncertain = current
            .as_ref()
            .is_some_and(|v| n(v, "create_uncertain") == 1 && s(v, "provider_id").is_empty());
        let retry = deleted
            || (attempts < 4
                && matches!(
                    error.0,
                    StatusCode::BAD_GATEWAY
                        | StatusCode::SERVICE_UNAVAILABLE
                        | StatusCode::GATEWAY_TIMEOUT
                ));
        let status = if deleted {
            "deleting"
        } else if retry {
            s(&row, "status")
        } else {
            "failed"
        };
        let safe_error = if uncertain {
            "远端创建结果尚未确认，清理等待自动核验"
        } else {
            match error.0 {
                StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::UNAUTHORIZED => {
                    "来源权限已变更或资料已删除，请调整来源后重试"
                }
                StatusCode::CONFLICT => "来源版本尚未就绪或已更新，请重新同步",
                _ => "知识服务处理失败，请检查服务配置和日志后重新同步",
            }
        };
        state.db.exec("UPDATE bot_knowledge_assets SET status=?,error=?,attempts=?,available_at=?,lease_until=0,lease_token='',updated_at=? WHERE id=? AND lease_token=?",
            vec![json!(status),json!(safe_error),json!(attempts),json!(now()+30_000*(1_i64<<attempts.min(6))),json!(now()),row["id"].clone(),json!(token)]).await?;
    }
    // A deletion may have raced a successful build; release its lease for cleanup.
    state.db.exec("UPDATE bot_knowledge_assets SET lease_until=0,lease_token='',available_at=0 WHERE id=? AND deleted=1 AND lease_token=?",
        vec![row["id"].clone(),json!(token)]).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_repository_urls_are_closed_to_arbitrary_sources() {
        assert_eq!(
            repository_url("https://github.com/TencentCloud/TencentDB-Agent-Memory").unwrap(),
            "https://github.com/TencentCloud/TencentDB-Agent-Memory.git"
        );
        for value in [
            "https://127.0.0.1/repo.git",
            "https://localhost/repo",
            "http://github.com/a/b",
            "https://github.com:8443/a/b",
            "https://u:secret@github.com/a/b",
            "git@github.com:a/b.git",
            "https://github.com/a/b?token=x",
            "https://github.com/a/b/tree/main",
            "https://github.com/a/%2e%2e",
        ] {
            assert!(repository_url(value).is_err(), "{value}");
        }
    }
    #[test]
    fn query_arguments_cannot_override_provider_identity() {
        assert!(params(
            "wiki",
            "search",
            &json!({"query":"fact","knowledge_id":"foreign"})
        )
        .is_err());
        assert!(params("code_graph", "impact", &json!({"symbol":"foo","depth":99})).is_err());
        assert!(params("wiki", "read_page", &json!({"refs":["../../secret"]})).is_err());
        assert!(params("wiki", "delete", &json!({})).is_err());
    }
}
