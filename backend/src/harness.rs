//! Official DeepSeek Harness SDK and Cordis bundles, in private per-user profiles.
use crate::{
    auth::{audit, Actor},
    db::{id, n, now, s, Record},
    error::{AppError, Result},
    models, web, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

const NPM: &str = "https://registry.npmjs.org";
pub fn script(state: &AppState, name: &str) -> PathBuf {
    std::path::Path::new(&state.config.agent_script)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("agent-runtime"))
        .join(name)
}
pub(crate) async fn manager(
    state: &AppState,
    actor: &Actor,
    operation: &str,
    mut input: Value,
) -> Result<Value> {
    input["operation"] = json!(operation);
    input["root"] = json!(state.config.harness_path.to_string_lossy());
    input["tenant_id"] = json!(actor.tenant_id);
    input["user_id"] = json!(actor.id);
    let mut child = Command::new(&state.config.agent_node)
        .arg(script(state, "harness-manager.mjs"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            AppError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Harness包管理未启动，请检查Node.js及运行时依赖".into(),
            )
        })?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .await
        .map_err(|_| AppError::bad("Harness管理通信失败"))?;
    let output = tokio::time::timeout(
        Duration::from_secs(if operation == "update" { 600 } else { 300 }),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        AppError(
            StatusCode::GATEWAY_TIMEOUT,
            "Harness操作超时，请重新读取插件状态".into(),
        )
    })?
    .map_err(|_| AppError::bad("Harness管理进程失败"))?;
    if output.stdout.len() > 100_000 {
        return Err(AppError::bad("Harness管理输出超过限制"));
    }
    let result: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Harness依赖未就绪，请安装agent-runtime依赖".into(),
        )
    })?;
    if result["ok"] != true {
        return Err(AppError::bad(
            result["error"].as_str().unwrap_or("Harness操作失败"),
        ));
    }
    Ok(result["data"].clone())
}
pub async fn available(state: &AppState) -> bool {
    state.config.harness_enabled
        && matches!(tokio::time::timeout(Duration::from_secs(3),Command::new("docker")
        .args(["image","inspect",&state.config.harness_image]).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).status()).await,Ok(Ok(s)) if s.success())
}
async fn latest() -> Result<Value> {
    let bytes =
        web::download_public(&format!("{NPM}/@deepseek-ai%2Fdsh/latest"), 2_000_000).await?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::bad("官方版本信息无效"))
}
pub async fn status(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.admin()?;
    let (installed, upstream, ready) = tokio::join!(
        manager(&state, &actor, "status", json!({})),
        latest(),
        available(&state)
    );
    let current = installed
        .as_ref()
        .ok()
        .and_then(|v| v["installed_version"].as_str());
    let newest = upstream.as_ref().ok().and_then(|v| v["version"].as_str());
    let error = if !state.config.harness_enabled {
        Some("管理员已关闭Harness云端执行".to_owned())
    } else if installed.is_err() {
        Some("Harness运行时依赖未安装".to_owned())
    } else if !ready {
        Some("隔离运行环境未就绪，请启动Harness sandbox并准备Node镜像".to_owned())
    } else {
        None
    };
    Ok(Json(
        json!({"available":ready && current.is_some(),"installed_version":current,"latest_version":newest,"update_available":current.zip(newest).is_some_and(|(a,b)|a!=b),"engine":"deepseek-harness","registry":NPM,"is_admin":actor.role=="admin","features":{"sdk":true,"plugins":true,"mcp":true,"skills":true,"isolation":"docker"},"error":error,"version_error":upstream.err().map(|e|e.1)}),
    ))
}
pub async fn update(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.admin()?;
    let metadata = latest().await?;
    let version = metadata["version"]
        .as_str()
        .ok_or_else(|| AppError::bad("官方版本信息无效"))?;
    let result = manager(&state, &actor, "update", json!({"version":version})).await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "harness.update",
        None,
        json!({"version":version}),
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"installed_version":result["installed_version"],"latest_version":version,"update_available":false,"application":"next-task"}),
    ))
}
pub async fn installed(state: &AppState, actor: &Actor) -> Result<Vec<Record>> {
    Ok(state
        .db
        .rows(
            "SELECT * FROM bot_harness_plugins WHERE tenant_id=? AND user_id=? ORDER BY name",
            vec![json!(actor.tenant_id), json!(actor.id)],
        )
        .await?)
}
fn plugin(row: &Record) -> Value {
    json!({"id":s(row,"name"),"name":s(row,"name"),"source":s(row,"source"),"marketplace":s(row,"marketplace"),"version":s(row,"version"),"description":s(row,"description"),"category":"扩展","installed":true,"enabled":n(row,"enabled")==1,"has_config":!s(row,"encrypted_config").is_empty(),"config_rows":serde_json::from_str::<Value>(s(row,"config_rows")).unwrap_or(json!([]))})
}
async fn enabled_names(state: &AppState, actor: &Actor) -> Result<Vec<String>> {
    Ok(installed(state, actor)
        .await?
        .iter()
        .filter(|row| n(row, "enabled") == 1)
        .map(|row| s(row, "name").to_owned())
        .collect())
}
async fn markets(state: &AppState, actor: &Actor) -> Result<Vec<Value>> {
    let mut list = vec![json!({"id":"npm","name":"npm · Harness插件","source":NPM,"builtin":true})];
    for row in state.db.rows("SELECT id,name,source FROM bot_harness_marketplaces WHERE tenant_id=? AND user_id=? ORDER BY created_at",vec![json!(actor.tenant_id),json!(actor.id)]).await? {let mut value=json!(row);value["builtin"]=json!(false);list.push(value);}
    Ok(list)
}
fn registry_url(source: &str) -> Result<String> {
    let url = web::public_url(source)?;
    if url.scheme() != "https" || url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::bad("插件市场需为公开HTTPS npm registry地址"));
    }
    Ok(source.trim_end_matches('/').to_owned())
}
async fn registry(state: &AppState, actor: &Actor, key: Option<&str>) -> Result<String> {
    match key {
        None | Some("npm") => Ok(NPM.into()),
        Some(key) => {
            let row=state.db.one("SELECT source FROM bot_harness_marketplaces WHERE id=? AND tenant_id=? AND user_id=?",vec![json!(key),json!(actor.tenant_id),json!(actor.id)]).await?.ok_or_else(AppError::missing)?;
            registry_url(s(&row, "source"))
        }
    }
}
#[derive(Deserialize)]
pub struct CatalogQuery {
    pub q: Option<String>,
    pub marketplace: Option<String>,
}
pub async fn catalog(
    State(state): State<AppState>,
    actor: Actor,
    Query(query): Query<CatalogQuery>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let selected = registry(&state, &actor, query.marketplace.as_deref()).await?;
    let term = query.q.unwrap_or_else(|| "deepseek harness dsh".into());
    if term.chars().count() > 150 {
        return Err(AppError::bad("搜索词过长"));
    }
    let mut url = reqwest::Url::parse(&format!("{selected}/-/v1/search"))
        .map_err(|_| AppError::bad("市场地址无效"))?;
    url.query_pairs_mut()
        .append_pair("text", &term)
        .append_pair("size", "40");
    let found = web::download_public(url.as_str(), 2_000_000)
        .await
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| AppError::bad("市场响应无效"))
        });
    let owned = installed(&state, &actor).await?;
    let mut plugins: Vec<Value> = owned.iter().map(plugin).collect();
    if let Ok(data) = &found {
        for item in data["objects"].as_array().unwrap_or(&vec![]) {
            let package = &item["package"];
            let name = package["name"].as_str().unwrap_or("");
            if name.is_empty() || plugins.iter().any(|v| v["id"] == name) {
                continue;
            }
            // The registry is discovery; installation verifies the real dsh.bundle manifest.
            if query.marketplace.as_deref().unwrap_or("npm") == "npm"
                && !name.contains("dsh")
                && !name.contains("harness")
            {
                continue;
            }
            plugins.push(json!({"id":name,"name":name,"description":package["description"],"version":package["version"],"source":name,"category":if name.contains("mcp") {"MCP"} else if name.contains("skill") {"技能"} else {"扩展"},"installed":false,"enabled":false,"homepage":package["links"]["homepage"],"author":package["publisher"]["username"]}));
        }
    }
    if !term.is_empty() && term != "deepseek harness dsh" {
        let needle = term.to_lowercase();
        plugins.retain(|v| {
            format!(
                "{} {}",
                v["name"].as_str().unwrap_or(""),
                v["description"].as_str().unwrap_or("")
            )
            .to_lowercase()
            .contains(&needle)
        });
    }
    Ok(Json(
        json!({"plugins":plugins,"marketplaces":markets(&state,&actor).await?,"error":found.err().map(|e|e.1)}),
    ))
}
#[derive(Deserialize)]
pub struct InstallInput {
    pub source: String,
    pub marketplace: Option<String>,
}
pub async fn install(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<InstallInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    if input.source.is_empty()
        || input.source.len() > 2048
        || input
            .source
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        || input.source.starts_with('-')
    {
        return Err(AppError::bad("插件来源无效"));
    }
    if input.source.contains("://") {
        web::download_public(input.source.trim_start_matches("git+"), 1)
            .await
            .or_else(|e| {
                if e.1.contains("超过") {
                    Ok(vec![])
                } else {
                    Err(e)
                }
            })?;
    }
    let selected = registry(&state, &actor, input.marketplace.as_deref()).await?;
    // Validate DNS before handing the registry to pnpm; management never inherits API/model secrets.
    web::download_public(&selected, 2_000_000).await?;
    if installed(&state, &actor).await?.len() >= 100 {
        return Err(AppError::bad("最多安装100个插件"));
    }
    let mut result=manager(&state,&actor,"install",json!({"source":input.source,"registry":selected,"enabled_names":enabled_names(&state,&actor).await?})).await?;
    let market = input.marketplace.as_deref().unwrap_or("npm");
    result["marketplace"] = json!(market);
    state.db.exec("INSERT INTO bot_harness_plugins(tenant_id,user_id,name,source,marketplace,version,description,config_rows,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?) ON CONFLICT(tenant_id,user_id,name) DO UPDATE SET source=excluded.source,marketplace=excluded.marketplace,version=excluded.version,description=excluded.description,config_rows=excluded.config_rows,enabled=1,updated_at=excluded.updated_at",vec![json!(actor.tenant_id),json!(actor.id),result["name"].clone(),json!(input.source),json!(market),result["version"].clone(),result["description"].clone(),json!(result["config_rows"].to_string()),json!(now())]).await?;
    if let Some(row)=state.db.one("SELECT encrypted_config FROM bot_harness_plugins WHERE tenant_id=? AND user_id=? AND name=?",vec![json!(actor.tenant_id),json!(actor.id),result["name"].clone()]).await? {result["has_config"]=json!(!s(&row,"encrypted_config").is_empty());}
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "harness.plugin.install",
        None,
        json!({"name":result["name"]}),
    )
    .await?;
    Ok(Json(result))
}
pub async fn configuration(
    State(state): State<AppState>,
    actor: Actor,
    Path(name): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let row = owned_plugin(&state, &actor, &name).await?;
    let metadata = manager(&state, &actor, "inspect", json!({"name":name})).await?;
    Ok(Json(
        json!({"has_config":!s(&row,"encrypted_config").is_empty(),"rows":metadata["config_rows"]}),
    ))
}
#[derive(Deserialize)]
pub struct ConfigureInput {
    pub config: Value,
}
pub async fn configure(
    State(state): State<AppState>,
    actor: Actor,
    Path(name): Path<String>,
    Json(input): Json<ConfigureInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    owned_plugin(&state, &actor, &name).await?;
    let object = input
        .config
        .as_object()
        .ok_or_else(|| AppError::bad("配置需为Cordis row ID到Config对象的JSON映射"))?;
    if input.config.to_string().len() > 100_000 {
        return Err(AppError::bad("插件配置超过100KB"));
    }
    let metadata = manager(&state, &actor, "inspect", json!({"name":name})).await?;
    for (key, value) in object {
        if !value.is_object()
            || !metadata["config_rows"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .any(|row| row["id"] == *key)
        {
            return Err(AppError::bad(
                "配置仅能修改该插件声明的Cordis row，且每项需为对象",
            ));
        }
    }
    let encrypted = if object.is_empty() {
        String::new()
    } else {
        models::seal(
            &state,
            &actor.tenant_id,
            &json!({"plugin":name,"config":input.config}),
        )?
    };
    state.db.exec("UPDATE bot_harness_plugins SET encrypted_config=?,config_rows=?,updated_at=? WHERE tenant_id=? AND user_id=? AND name=?",vec![json!(encrypted),json!(metadata["config_rows"].to_string()),json!(now()),json!(actor.tenant_id),json!(actor.id),json!(name)]).await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "harness.plugin.configure",
        None,
        json!({"name":name,"has_config":!object.is_empty()}),
    )
    .await?;
    Ok(Json(json!({"ok":true,"has_config":!object.is_empty()})))
}
pub async fn task_configuration(state: &AppState, actor: &Actor, keys: &[String]) -> Result<Value> {
    let mut result = serde_json::Map::new();
    for key in keys {
        let row = owned_plugin(state, actor, key).await?;
        if n(&row, "enabled") != 1 {
            return Err(AppError::bad("任务所选插件已停用"));
        }
        if !s(&row, "encrypted_config").is_empty() {
            let saved: Value = models::open(state, &actor.tenant_id, s(&row, "encrypted_config"))?;
            if saved["plugin"] != *key {
                return Err(AppError::bad("插件配置无效"));
            }
            result.insert(key.clone(), saved["config"].clone());
        }
    }
    Ok(Value::Object(result))
}
async fn owned_plugin(state: &AppState, actor: &Actor, name: &str) -> Result<Record> {
    state
        .db
        .one(
            "SELECT * FROM bot_harness_plugins WHERE name=? AND tenant_id=? AND user_id=?",
            vec![json!(name), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        .ok_or_else(AppError::missing)
}
#[derive(Deserialize)]
pub struct EnableInput {
    pub enabled: bool,
}
pub async fn enable(
    State(state): State<AppState>,
    actor: Actor,
    Path(name): Path<String>,
    Json(input): Json<EnableInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let mut row = owned_plugin(&state, &actor, &name).await?;
    let mut enabled = enabled_names(&state, &actor).await?;
    enabled.retain(|v| v != &name);
    if input.enabled {
        enabled.push(name.clone());
    }
    manager(&state, &actor, "enable", json!({"enabled_names":enabled})).await?;
    state.db.exec("UPDATE bot_harness_plugins SET enabled=?,updated_at=? WHERE name=? AND tenant_id=? AND user_id=?",vec![json!(input.enabled),json!(now()),json!(name),json!(actor.tenant_id),json!(actor.id)]).await?;
    row.insert("enabled".into(), json!(if input.enabled { 1 } else { 0 }));
    Ok(Json(plugin(&row)))
}
pub async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    Path(name): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    owned_plugin(&state, &actor, &name).await?;
    manager(
        &state,
        &actor,
        "remove",
        json!({"name":name,"enabled_names":enabled_names(&state,&actor).await?}),
    )
    .await?;
    state
        .db
        .exec(
            "DELETE FROM bot_harness_plugins WHERE name=? AND tenant_id=? AND user_id=?",
            vec![json!(name), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct MarketInput {
    pub source: String,
    pub name: Option<String>,
}
pub async fn add_market(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<MarketInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let source = registry_url(&input.source)?;
    let mut test = reqwest::Url::parse(&format!("{source}/-/v1/search")).unwrap();
    test.query_pairs_mut()
        .append_pair("text", "dsh")
        .append_pair("size", "1");
    let response = web::download_public(test.as_str(), 2_000_000).await?;
    let metadata: Value = serde_json::from_slice(&response)
        .map_err(|_| AppError::bad("该地址没有提供npm registry搜索接口"))?;
    if !metadata["objects"].is_array() {
        return Err(AppError::bad("该地址不是兼容的npm插件市场"));
    }
    let name = input.name.unwrap_or_else(|| {
        reqwest::Url::parse(&source)
            .unwrap()
            .host_str()
            .unwrap()
            .to_owned()
    });
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::bad("市场名称需为1–80字"));
    }
    let key = id();
    state.db.exec("INSERT INTO bot_harness_marketplaces(id,tenant_id,user_id,name,source,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,source) DO UPDATE SET name=excluded.name",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(name),json!(source),json!(now())]).await?;
    let result=state.db.one("SELECT id,name,source FROM bot_harness_marketplaces WHERE tenant_id=? AND user_id=? AND source=?",vec![json!(actor.tenant_id),json!(actor.id),json!(source)]).await?.unwrap();
    Ok(Json(json!(result)))
}
pub async fn remove_market(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    if state
        .db
        .exec(
            "DELETE FROM bot_harness_marketplaces WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?
        == 0
    {
        return Err(AppError::missing());
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn validate_selection(
    state: &AppState,
    actor: &Actor,
    options: &crate::bot::Options,
) -> Result<()> {
    if options.local_device_id.is_some()
        && (options.runtime.as_deref() == Some("deepseek-harness")
            || !options.plugin_ids.is_empty())
    {
        return Err(AppError::bad("Harness运行时与云端插件需使用云端处理"));
    }
    if options.plugin_ids.len() > 20 {
        return Err(AppError::bad("一个任务最多选择20个插件"));
    }
    let unique: std::collections::HashSet<_> = options.plugin_ids.iter().collect();
    if unique.len() != options.plugin_ids.len() {
        return Err(AppError::bad("任务插件选择不能重复"));
    }
    if options
        .runtime
        .as_deref()
        .is_some_and(|v| !matches!(v, "pi-agent-core" | "deepseek-harness"))
    {
        return Err(AppError::bad("运行时无效"));
    }
    if !options.plugin_ids.is_empty() && options.runtime.as_deref() != Some("deepseek-harness") {
        return Err(AppError::bad("Harness插件需选择DeepSeek Harness云端运行时"));
    }
    for key in &options.plugin_ids {
        let row = owned_plugin(state, actor, key).await?;
        if n(&row, "enabled") != 1 {
            return Err(AppError::bad("所选插件已停用，请先在插件市场启用"));
        }
    }
    if options.runtime.as_deref() == Some("deepseek-harness")
        && options.local_device_id.is_none()
        && !available(state).await
    {
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Harness云端隔离环境未就绪，请检查sandbox配置或选择Pi运行时".into(),
        ));
    }
    Ok(())
}
