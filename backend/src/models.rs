//! Tenant-scoped model settings. API responses and audits never contain provider secrets.
use crate::{
    auth::{audit, Actor},
    config::Config,
    db::{n, now, s},
    error::{AppError, Result},
    AppState,
};
use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub async fn encryption_key(config: &Config) -> anyhow::Result<Option<Arc<[u8; 32]>>> {
    if let Some(value) = std::env::var("MODEL_CONFIG_ENCRYPTION_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        let bytes = STANDARD.decode(value.trim())?;
        let key: [u8; 32] = bytes.try_into().map_err(|_| {
            anyhow::anyhow!("MODEL_CONFIG_ENCRYPTION_KEY must be base64 of 32 bytes")
        })?;
        return Ok(Some(Arc::new(key)));
    }
    if config.production {
        return Ok(None);
    }
    tokio::fs::create_dir_all(&config.storage_path).await?;
    let path = config.storage_path.join(".model-config-key");
    // create_new is atomic across API and worker processes; neither overwrites an existing key.
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    match options.open(&path).await {
        Ok(mut file) => {
            use tokio::io::AsyncWriteExt;
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            file.write_all(&key).await?;
            file.sync_all().await?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let mut bytes = tokio::fs::read(&path).await?;
    // A concurrent process may have created the file but not finished writing yet.
    for _ in 0..10 {
        if bytes.len() == 32 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        bytes = tokio::fs::read(&path).await?;
    }
    let key = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid model configuration encryption key file"))?;
    Ok(Some(Arc::new(key)))
}

fn cipher_key(key: Option<&Arc<[u8; 32]>>) -> anyhow::Result<LessSafeKey> {
    let key = key.ok_or_else(|| {
        anyhow::anyhow!("MODEL_CONFIG_ENCRYPTION_KEY is required to store model settings")
    })?;
    Ok(LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key.as_ref())
            .map_err(|_| anyhow::anyhow!("Invalid encryption key"))?,
    ))
}
pub(crate) fn seal<T: Serialize>(
    state: &AppState,
    tenant: &str,
    settings: &T,
) -> anyhow::Result<String> {
    seal_key(state.model_key.as_ref(), tenant, settings)
}
pub(crate) fn seal_key<T: Serialize>(
    key: Option<&Arc<[u8; 32]>>,
    tenant: &str,
    settings: &T,
) -> anyhow::Result<String> {
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut bytes = serde_json::to_vec(settings)?;
    cipher_key(key)?
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(tenant.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| anyhow::anyhow!("Model configuration encryption failed"))?;
    Ok(STANDARD.encode([nonce.to_vec(), bytes].concat()))
}
pub(crate) fn open<T: serde::de::DeserializeOwned>(
    state: &AppState,
    tenant: &str,
    encoded: &str,
) -> anyhow::Result<T> {
    open_key(state.model_key.as_ref(), tenant, encoded)
}
pub(crate) fn open_key<T: serde::de::DeserializeOwned>(
    key: Option<&Arc<[u8; 32]>>,
    tenant: &str,
    encoded: &str,
) -> anyhow::Result<T> {
    let mut bytes = STANDARD.decode(encoded)?;
    anyhow::ensure!(bytes.len() >= 28, "Invalid encrypted model configuration");
    let nonce: [u8; 12] = bytes[..12].try_into()?;
    let plaintext = cipher_key(key)?
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(tenant.as_bytes()),
            &mut bytes[12..],
        )
        .map_err(|_| anyhow::anyhow!("Cannot decrypt model settings; verify the encryption key"))?;
    Ok(serde_json::from_slice(plaintext)?)
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Provider {
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub dimensions: usize,
}
impl Provider {
    fn public(&self) -> Value {
        json!({"enabled":self.enabled,"base_url":self.base_url,"model":self.model,"has_api_key":!self.api_key.is_empty(),"dimensions":self.dimensions})
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MediaModel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub config: Provider,
}
impl MediaModel {
    fn public(&self) -> Value {
        json!({"id":self.id,"name":self.name,"kind":self.kind,"config":self.config.public()})
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub chat: Provider,
    pub embedding: Provider,
    pub vision: Provider,
    #[serde(default)]
    pub image: Provider,
    #[serde(default)]
    pub video: Provider,
    #[serde(default)]
    pub media_models: Option<Vec<MediaModel>>,
    #[serde(default)]
    pub default_image_id: Option<String>,
    #[serde(default)]
    pub default_video_id: Option<String>,
}
impl Settings {
    pub fn media(&self) -> &[MediaModel] {
        self.media_models.as_deref().unwrap_or(&[])
    }
    fn normalize_media(&mut self) {
        if self.media_models.is_none() {
            let mut rows = Vec::new();
            for (kind, provider) in [("image", &self.image), ("video", &self.video)] {
                if !provider.base_url.is_empty() || !provider.model.is_empty() {
                    rows.push(MediaModel {
                        id: format!("legacy-{kind}"),
                        name: if kind == "image" {
                            "默认生图模型"
                        } else {
                            "默认视频模型"
                        }
                        .into(),
                        kind: kind.into(),
                        config: provider.clone(),
                    });
                }
            }
            self.media_models = Some(rows);
        }
        self.sync_media_defaults();
    }
    fn sync_media_defaults(&mut self) {
        for kind in ["image", "video"] {
            let current = if kind == "image" {
                self.default_image_id.as_deref()
            } else {
                self.default_video_id.as_deref()
            };
            let selected = self
                .media()
                .iter()
                .find(|m| m.kind == kind && Some(m.id.as_str()) == current)
                .or_else(|| {
                    self.media()
                        .iter()
                        .find(|m| m.kind == kind && m.config.enabled)
                })
                .or_else(|| self.media().iter().find(|m| m.kind == kind));
            let key = selected.map(|m| m.id.clone());
            let provider = selected.map(|m| m.config.clone()).unwrap_or_default();
            if kind == "image" {
                self.default_image_id = key;
                self.image = provider;
            } else {
                self.default_video_id = key;
                self.video = provider;
            }
        }
    }
    pub fn selected_media(&self, kind: &str, key: Option<&str>) -> Result<Option<&MediaModel>> {
        if let Some(key) = key.filter(|key| !key.is_empty()) {
            return self
                .media()
                .iter()
                .find(|m| m.id == key && m.kind == kind && m.config.enabled)
                .map(Some)
                .ok_or_else(|| AppError::bad("所选创作模型已删除、停用或类型不符，请重新选择"));
        }
        let default = if kind == "image" {
            self.default_image_id.as_deref()
        } else {
            self.default_video_id.as_deref()
        };
        Ok(self
            .media()
            .iter()
            .find(|m| m.kind == kind && m.config.enabled && Some(m.id.as_str()) == default)
            .or_else(|| {
                self.media()
                    .iter()
                    .find(|m| m.kind == kind && m.config.enabled)
            }))
    }
    fn probe_provider(&self, kind: &str, key: Option<&str>) -> Result<Provider> {
        let Some(key) = key else {
            return Ok(self.provider(kind)?.clone());
        };
        if !["image", "video"].contains(&kind) {
            return Err(AppError::bad("模型配置 ID 仅用于创作模型"));
        }
        if let Some(model) = self.media().iter().find(|m| m.id == key) {
            if model.kind != kind {
                return Err(AppError::bad("模型类型与配置不一致"));
            }
            return Ok(model.config.clone());
        }
        // New rows have their own secret; never inherit another model's saved key.
        if uuid::Uuid::parse_str(key).is_err() {
            return Err(AppError::bad("模型配置 ID 无效"));
        }
        Ok(Provider::default())
    }

    pub(crate) fn provider(&self, kind: &str) -> Result<&Provider> {
        match kind {
            "chat" => Ok(&self.chat),
            "embedding" => Ok(&self.embedding),
            "vision" => Ok(&self.vision),
            "image" => Ok(&self.image),
            "video" => Ok(&self.video),
            _ => Err(AppError::bad("不支持的模型类型")),
        }
    }
    fn from_env(c: &Config) -> Self {
        let provider = |enabled, model: &str, base: &str, key: &str| Provider {
            enabled,
            model: model.into(),
            base_url: base.into(),
            api_key: key.into(),
            dimensions: c.embedding_dimensions,
        };
        Self {
            image: Provider::default(),
            video: Provider::default(),
            media_models: None,
            default_image_id: None,
            default_video_id: None,
            chat: provider(c.chat(), &c.chat_model, &c.ai_base_url, &c.ai_api_key),
            embedding: provider(
                c.embeddings(),
                &c.embedding_model,
                &c.ai_base_url,
                &c.ai_api_key,
            ),
            vision: provider(
                c.vision(),
                &c.vision_model,
                if c.vision_base_url.is_empty() {
                    &c.ai_base_url
                } else {
                    &c.vision_base_url
                },
                if c.vision_api_key.is_empty() {
                    &c.ai_api_key
                } else {
                    &c.vision_api_key
                },
            ),
        }
    }
    fn public(&self, state: &AppState, revision: i64) -> Value {
        json!({"chat":self.chat.public(),"embedding":self.embedding.public(),"vision":self.vision.public(),"image":self.image.public(),"video":self.video.public(),"media_models":self.media().iter().map(MediaModel::public).collect::<Vec<_>>(),"default_image_id":self.default_image_id,"default_video_id":self.default_video_id,"revision":revision,
            "source":if revision == 0 {"environment"}else{"database"},
            "can_save":state.model_key.is_some(),
            "postgres_dimensions":if state.db.postgres && state.config.qdrant_url.is_empty() {json!(state.config.embedding_dimensions)} else {Value::Null}})
    }
    pub fn apply(&self, base: &Config) -> Config {
        let mut c = base.clone();
        c.ai_api_key.clear();
        c.chat_base_url = self.chat.base_url.clone();
        c.chat_api_key = self.chat.api_key.clone();
        c.chat_model = self.chat.model.clone();
        c.chat_enabled = self.chat.enabled;
        c.embedding_base_url = self.embedding.base_url.clone();
        c.embedding_api_key = self.embedding.api_key.clone();
        c.embedding_model = self.embedding.model.clone();
        c.embedding_enabled = self.embedding.enabled;
        c.embedding_dimensions = self.embedding.dimensions;
        // Changing provider, model or dimensions must not compare incompatible old vectors.
        c.embedding_index_id = format!(
            "config-v1:{:x}",
            Sha256::digest(format!(
                "{}\n{}\n{}",
                self.embedding.base_url, self.embedding.model, self.embedding.dimensions
            ))
        );
        c.vision_base_url = self.vision.base_url.clone();
        c.vision_api_key = self.vision.api_key.clone();
        c.vision_model = self.vision.model.clone();
        c.vision_enabled = self.vision.enabled;
        c
    }
}
pub async fn load(state: &AppState, tenant: &str) -> anyhow::Result<(Settings, i64)> {
    let (mut settings, revision) = match state
        .db
        .one(
            "SELECT payload,revision FROM tenant_model_configs WHERE tenant_id=?",
            vec![json!(tenant)],
        )
        .await?
    {
        Some(row) => (
            open(state, tenant, s(&row, "payload"))?,
            n(&row, "revision"),
        ),
        None => (Settings::from_env(&state.config), 0),
    };
    settings.normalize_media();
    Ok((settings, revision))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderInput {
    enabled: bool,
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
    dimensions: Option<usize>,
}
impl ProviderInput {
    fn merge(&self, old: &Provider, kind: &str) -> Result<Provider> {
        let dimensions = self.dimensions.unwrap_or(old.dimensions);
        if kind == "embedding" && !(1..=2000).contains(&dimensions) {
            return Err(AppError::bad("向量维度必须为 1–2000"));
        }
        let base_url = self.base_url.trim().trim_end_matches('/').to_owned();
        let model = self.model.trim().to_owned();
        if base_url.len() > 2048
            || model.len() > 256
            || self.api_key.as_ref().is_some_and(|v| v.len() > 8192)
        {
            return Err(AppError::bad("模型配置字段过长"));
        }
        if !base_url.is_empty() {
            let url = reqwest::Url::parse(&base_url)
                .map_err(|_| AppError::bad("请输入有效的模型服务 URL"))?;
            if !["http", "https"].contains(&url.scheme())
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(AppError::bad(
                    "服务地址必须为 HTTP/HTTPS，不能包含账号、密码、查询参数或片段",
                ));
            }
        }
        if self.enabled && (base_url.is_empty() || model.is_empty()) {
            return Err(AppError::bad("启用模型时必须填写服务地址和模型名称"));
        }
        let api_key = if self.clear_api_key {
            String::new()
        } else {
            self.api_key
                .as_ref()
                .filter(|v| !v.trim().is_empty())
                .map(|v| v.trim().to_owned())
                .unwrap_or_else(|| old.api_key.clone())
        };
        Ok(Provider {
            enabled: self.enabled,
            base_url,
            model,
            api_key,
            dimensions,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveInput {
    revision: i64,
    chat: ProviderInput,
    embedding: ProviderInput,
    vision: ProviderInput,
    image: Option<ProviderInput>,
    video: Option<ProviderInput>,
    media_models: Option<Vec<MediaModelInput>>,
    default_image_id: Option<String>,
    default_video_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaModelInput {
    id: String,
    name: String,
    kind: String,
    config: ProviderInput,
}
pub async fn get(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.admin()?;
    let (settings, revision) = load(&state, &actor.tenant_id).await?;
    Ok(Json(settings.public(&state, revision)))
}
pub async fn save(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<SaveInput>,
) -> Result<Json<Value>> {
    actor.admin()?;
    if state.model_key.is_none() {
        return Err(AppError::bad(
            "请由部署管理员设置 MODEL_CONFIG_ENCRYPTION_KEY 后启用页面保存",
        ));
    }
    let (old, revision) = load(&state, &actor.tenant_id).await?;
    if input.revision != revision {
        return Err(conflict());
    }
    let mut settings = Settings {
        chat: input.chat.merge(&old.chat, "chat")?,
        embedding: input.embedding.merge(&old.embedding, "embedding")?,
        vision: input.vision.merge(&old.vision, "vision")?,
        image: input
            .image
            .as_ref()
            .map(|p| p.merge(&old.image, "image"))
            .transpose()?
            .unwrap_or(old.image.clone()),
        video: input
            .video
            .as_ref()
            .map(|p| p.merge(&old.video, "video"))
            .transpose()?
            .unwrap_or(old.video.clone()),
        media_models: old.media_models.clone(),
        default_image_id: old.default_image_id.clone(),
        default_video_id: old.default_video_id.clone(),
    };
    if let Some(rows) = &input.media_models {
        if rows.len() > 40 {
            return Err(AppError::bad("最多保存 40 组创作模型"));
        }
        let mut seen = std::collections::HashSet::new();
        let mut media = Vec::new();
        for row in rows {
            if !["image", "video"].contains(&row.kind.as_str())
                || !seen.insert(&row.id)
                || (uuid::Uuid::parse_str(&row.id).is_err()
                    && row.id != format!("legacy-{}", row.kind))
                || row.name.trim().is_empty()
                || row.name.chars().count() > 80
            {
                return Err(AppError::bad(
                    "创作模型配置 ID、类型或名称无效，不能重复 ID",
                ));
            }
            let previous = old.media().iter().find(|m| m.id == row.id);
            if previous.is_some_and(|m| m.kind != row.kind) {
                return Err(AppError::bad("不能更改已有模型配置的类型，请新增配置"));
            }
            let empty = Provider::default();
            let config = row
                .config
                .merge(previous.map(|m| &m.config).unwrap_or(&empty), &row.kind)?;
            media.push(MediaModel {
                id: row.id.clone(),
                name: row.name.trim().into(),
                kind: row.kind.clone(),
                config,
            });
        }
        for (kind, key) in [
            ("image", &input.default_image_id),
            ("video", &input.default_video_id),
        ] {
            if key
                .as_ref()
                .is_some_and(|key| !media.iter().any(|m| &m.id == key && m.kind == kind))
            {
                return Err(AppError::bad("默认模型必须属于对应类型的已保存配置"));
            }
        }
        settings.media_models = Some(media);
        settings.default_image_id = input.default_image_id.clone();
        settings.default_video_id = input.default_video_id.clone();
    } else {
        // Legacy callers may edit their default media provider without erasing the catalog.
        for (kind, value) in [("image", &input.image), ("video", &input.video)] {
            if value.is_none() {
                continue;
            }
            let provider = if kind == "image" {
                settings.image.clone()
            } else {
                settings.video.clone()
            };
            let key = if kind == "image" {
                settings.default_image_id.clone()
            } else {
                settings.default_video_id.clone()
            };
            let rows = settings.media_models.as_mut().unwrap();
            if let Some(row) = rows.iter_mut().find(|m| Some(&m.id) == key.as_ref()) {
                row.config = provider;
            } else if !provider.base_url.is_empty() || !provider.model.is_empty() {
                rows.push(MediaModel {
                    id: format!("legacy-{kind}"),
                    name: if kind == "image" {
                        "默认生图模型"
                    } else {
                        "默认视频模型"
                    }
                    .into(),
                    kind: kind.into(),
                    config: provider,
                });
            }
        }
    }
    settings.sync_media_defaults();
    if state.db.postgres
        && state.config.qdrant_url.is_empty()
        && settings.embedding.enabled
        && settings.embedding.dimensions != state.config.embedding_dimensions
    {
        return Err(AppError::bad(format!(
            "当前数据库向量维度为 {}，请使用相同维度；更改维度需先执行部署文档中的数据库迁移",
            state.config.embedding_dimensions
        )));
    }
    let reindex_required = old.embedding.enabled != settings.embedding.enabled
        || old.embedding.base_url != settings.embedding.base_url
        || old.embedding.model != settings.embedding.model
        || old.embedding.dimensions != settings.embedding.dimensions
        || old.vision.enabled != settings.vision.enabled
        || old.vision.base_url != settings.vision.base_url
        || old.vision.model != settings.vision.model
        || (revision == 0 && settings.embedding.enabled);
    let payload = seal(&state, &actor.tenant_id, &settings)?;
    let mut tx = state.db.pool.begin().await?;
    let changed = if revision == 0 {
        state.db.tx_exec(&mut tx,"INSERT INTO tenant_model_configs(tenant_id,payload,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(tenant_id) DO NOTHING",vec![json!(actor.tenant_id),json!(payload),json!(now())]).await?
    } else {
        state.db.tx_exec(&mut tx,"UPDATE tenant_model_configs SET payload=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND revision=?",vec![json!(payload),json!(now()),json!(actor.tenant_id),json!(revision)]).await?
    };
    if changed != 1 {
        return Err(conflict());
    }
    // Commit the audit with the configuration; neither may contain secrets.
    state.db.tx_exec(&mut tx,"INSERT INTO audit_events(id,tenant_id,user_id,action,details,created_at) VALUES(?,?,?,'models.update',?,?)",vec![json!(crate::db::id()),json!(actor.tenant_id),json!(actor.id),json!(json!({"revision":revision+1,"reindex_required":reindex_required}).to_string()),json!(now())]).await?;
    tx.commit().await?;
    let mut public = settings.public(&state, revision + 1);
    public["reindex_required"] = json!(reindex_required);
    Ok(Json(public))
}
fn conflict() -> AppError {
    AppError(
        StatusCode::CONFLICT,
        "配置已被其他管理员修改，请重新加载后再保存或测试".into(),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestInput {
    kind: String,
    #[serde(default)]
    config_id: Option<String>,
    revision: i64,
    config: ProviderInput,
}
pub(crate) async fn response_json(
    mut response: reqwest::Response,
    maximum: usize,
) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 | 403 => "认证失败或无模型访问权限，请检查 API Key",
            404 => "接口不存在，请检查服务地址及接口兼容性",
            429 => "服务限流或额度不足",
            _ => "服务商请求失败，请检查配置或稍后重试",
        };
        return Err(AppError::bad(format!(
            "HTTP {}：{message}",
            status.as_u16()
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::bad("读取模型响应失败"))?
    {
        if bytes.len() + chunk.len() > maximum {
            return Err(AppError::bad("模型响应超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| AppError::bad("服务商响应不是有效 JSON"))
}
async fn model_list(state: &AppState, provider: &Provider) -> Result<Vec<String>> {
    if provider.base_url.is_empty() {
        return Err(AppError::bad("请先填写服务地址"));
    }
    let mut request = state
        .http
        .get(format!("{}/models", provider.base_url))
        .timeout(Duration::from_secs(20));
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|_| AppError::bad("获取模型列表失败，请检查服务地址、网络及 TLS 证书"))?;
    let payload = response_json(response, 2_000_000).await?;
    let rows = payload["data"]
        .as_array()
        .or_else(|| payload["models"].as_array())
        .ok_or_else(|| AppError::bad("服务商未返回模型列表；可手动填写模型名称"))?;
    let ids = rows
        .iter()
        .take(2000)
        .filter_map(|row| {
            row["id"]
                .as_str()
                .or_else(|| row["name"].as_str())
                .or_else(|| row.as_str())
        })
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .map(str::to_owned)
        .collect::<std::collections::BTreeSet<_>>();
    Ok(ids.into_iter().collect())
}
pub async fn discover(
    State(state): State<AppState>,
    actor: Actor,
    Json(mut input): Json<TestInput>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let (settings, revision) = load(&state, &actor.tenant_id).await?;
    if input.revision != revision {
        return Err(conflict());
    }
    let old = settings.probe_provider(&input.kind, input.config_id.as_deref())?;
    if !old.api_key.is_empty()
        && !input.config.clear_api_key
        && input
            .config
            .api_key
            .as_ref()
            .is_none_or(|key| key.trim().is_empty())
        && input.config.base_url.trim().trim_end_matches('/') != old.base_url
    {
        return Err(AppError::bad(
            "服务地址已改变，请输入新服务的 API Key，或明确清除原密钥",
        ));
    }
    input.config.enabled = false;
    let provider = input.config.merge(&old, &input.kind)?;
    let list = model_list(&state, &provider).await?;
    Ok(Json(
        json!({"models":list,"message":"模型列表已获取；请按用途选择支持对应接口的模型"}),
    ))
}
pub async fn test(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<TestInput>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let (settings, revision) = load(&state, &actor.tenant_id).await?;
    if input.revision != revision {
        return Err(conflict());
    }
    let old = settings.probe_provider(&input.kind, input.config_id.as_deref())?;
    let mut provider = input.config.merge(&old, &input.kind)?;
    provider.enabled = true;
    if provider.base_url.is_empty() || provider.model.is_empty() {
        return Err(AppError::bad("测试前请填写服务地址和模型名称"));
    }
    let start = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        probe(&state, &provider, &input.kind),
    )
    .await;
    let (success, message, dimensions) = match result {
        Ok(Ok(dimensions)) => (
            true,
            if ["image", "video"].contains(&input.kind.as_str()) {
                "模型列表连接正常；生成接口请在创作台实际验证（可能产生费用）".to_owned()
            } else {
                "实际模型调用成功，响应格式正常".to_owned()
            },
            dimensions,
        ),
        Ok(Err(message)) => (false, message, None),
        Err(_) => (
            false,
            "调用超时（30 秒），请检查服务地址与网络".into(),
            None,
        ),
    };
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "models.test",
        None,
        json!({"kind":input.kind,"success":success}),
    )
    .await?;
    Ok(Json(
        json!({"success":success,"message":message,"latency_ms":start.elapsed().as_millis() as u64,"dimensions":dimensions}),
    ))
}
async fn probe(
    state: &AppState,
    provider: &Provider,
    kind: &str,
) -> std::result::Result<Option<usize>, String> {
    if ["image", "video"].contains(&kind) {
        let models = model_list(state, provider).await.map_err(|e| e.1)?;
        if !models.contains(&provider.model) {
            return Err("当前模型不在服务商列表中，请重新选择或直接在创作台验证".into());
        }
        return Ok(None);
    }
    let (path, body) = if kind == "embedding" {
        (
            "embeddings",
            json!({"model":provider.model,"input":["企业知识库模型连接测试"]}),
        )
    } else {
        let content = if kind == "vision" {
            // A real 16×16 PNG; testing /models alone cannot verify image input support.
            json!([{"type":"text","text":"请描述图片的颜色。"},{"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",include_str!("../assets/probe-image.base64").trim())}}])
        } else {
            json!("请回复：连接成功")
        };
        (
            "chat/completions",
            json!({"model":provider.model,"max_tokens":100,"messages":[{"role":"user","content":content}]}),
        )
    };
    let mut request = state
        .http
        .post(format!("{}/{path}", provider.base_url))
        .json(&body);
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "无法连接模型服务，请检查地址、网络及 TLS 证书".to_owned())?;
    let status = response.status();
    if !status.is_success() {
        let reason = match status.as_u16() {
            401 | 403 => "认证失败或无模型访问权限，请检查 API Key",
            404 => "接口或模型不存在，请检查 Base URL（通常包含 /v1）与模型名称",
            429 => "服务限流或额度不足",
            500..=599 => "模型服务异常",
            _ => "模型服务拒绝了请求，请检查模型是否支持该接口",
        };
        return Err(format!("HTTP {}：{reason}", status.as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取模型响应失败".to_owned())?
    {
        if bytes.len() + chunk.len() > 1_000_000 {
            return Err("模型响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "响应不是有效 JSON，请检查是否填写了模型 API 地址".to_owned())?;
    if kind == "embedding" {
        let data = payload["data"]
            .as_array()
            .filter(|v| v.len() == 1)
            .ok_or("向量响应格式异常：缺少单条 data")?;
        let vector: Vec<f64> = serde_json::from_value(data[0]["embedding"].clone())
            .map_err(|_| "向量响应格式异常".to_owned())?;
        if vector.len() != provider.dimensions {
            return Err(format!(
                "向量维度不匹配：配置 {}，实际返回 {}。请修改维度后重试",
                provider.dimensions,
                vector.len()
            ));
        }
        if vector.iter().any(|n| !n.is_finite()) || !vector.iter().any(|n| *n != 0.0) {
            return Err("返回了无效或全零向量".into());
        }
        Ok(Some(vector.len()))
    } else {
        let text = payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        if text.trim().is_empty() {
            return Err("模型未返回有效文本，请检查模型是否支持该接口".into());
        }
        Ok(None)
    }
}
