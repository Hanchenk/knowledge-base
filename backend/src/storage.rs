use crate::{
    auth::{audit, Actor},
    config::Config,
    db::{id, n, now, s, Db},
    error::{AppError, Result},
    models, AppState,
};
use axum::{extract::State, Json};
use s3::{creds::Credentials, Bucket, Region};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct S3Settings {
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
}
impl S3Settings {
    fn from_config(c: &Config) -> Self {
        Self {
            endpoint: c.s3_endpoint.clone(),
            bucket: c.s3_bucket.clone(),
            access_key: c.s3_access_key.clone(),
            secret_key: c.s3_secret_key.clone(),
            region: c.s3_region.clone(),
        }
    }
    fn client(&self) -> anyhow::Result<Box<Bucket>> {
        let region = if self.endpoint.is_empty() {
            self.region.parse()?
        } else {
            Region::Custom {
                region: self.region.clone(),
                endpoint: self.endpoint.clone(),
            }
        };
        let credentials = Credentials::new(
            Some(&self.access_key),
            Some(&self.secret_key),
            None,
            None,
            None,
        )?;
        Ok(Bucket::new(&self.bucket, region, credentials)?.with_path_style())
    }
    fn public(&self) -> Value {
        json!({"endpoint":self.endpoint,"bucket":self.bucket,"access_key":self.access_key,"region":self.region,"has_secret":!self.secret_key.is_empty()})
    }
}
#[derive(Clone)]
pub struct Storage {
    path: PathBuf,
    default: S3Settings,
    db: Db,
    key: Option<Arc<[u8; 32]>>,
}
impl Storage {
    pub fn new(config: &Config, db: Db, key: Option<Arc<[u8; 32]>>) -> anyhow::Result<Self> {
        Ok(Self {
            path: config.storage_path.clone(),
            default: S3Settings::from_config(config),
            db,
            key,
        })
    }
    fn valid(key: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !key.starts_with('/')
                && key.split('/').all(|p| !p.is_empty()
                    && p != ".."
                    && p != "."
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')),
            "Invalid object key"
        );
        Ok(())
    }
    async fn profile(&self, profile: &str) -> anyhow::Result<S3Settings> {
        let row = self
            .db
            .one(
                "SELECT tenant_id,payload FROM storage_profiles WHERE id=?",
                vec![json!(profile)],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("Storage profile missing"))?;
        models::open_key(self.key.as_ref(), s(&row, "tenant_id"), s(&row, "payload"))
    }
    async fn upload(&self, key: &str, bytes: &[u8]) -> anyhow::Result<(String, Option<String>)> {
        Self::valid(key)?;
        let tenant = key.split('/').next().unwrap();
        let current = self
            .db
            .one(
                "SELECT profile_id FROM tenant_storage_configs WHERE tenant_id=?",
                vec![json!(tenant)],
            )
            .await?;
        let profile = current.as_ref().map(|r| s(r, "profile_id")).unwrap_or("");
        let config = if !profile.is_empty() {
            self.profile(profile).await?
        } else if current.is_some() {
            S3Settings::default()
        } else {
            self.default.clone()
        };
        let backend = if config.bucket.is_empty() {
            let path = self.path.join(key);
            tokio::fs::create_dir_all(path.parent().unwrap()).await?;
            let tmp = path.with_extension(format!("{}.tmp", id()));
            tokio::fs::write(&tmp, bytes).await?;
            tokio::fs::rename(tmp, path).await?;
            "local"
        } else {
            let r = config.client()?.put_object(key, bytes).await?;
            anyhow::ensure!(r.status_code() < 300, "S3 upload failed");
            if profile.is_empty() {
                "default"
            } else {
                "s3"
            }
        };
        Ok((
            backend.into(),
            if profile.is_empty() {
                None
            } else {
                Some(profile.into())
            },
        ))
    }
    pub async fn put(&self, key: &str, bytes: &[u8]) -> anyhow::Result<()> {
        let (backend, profile) = self.upload(key, bytes).await?;
        self.db.exec("INSERT INTO object_locations(object_key,backend,profile_id) VALUES(?,?,?) ON CONFLICT(object_key) DO UPDATE SET backend=excluded.backend,profile_id=excluded.profile_id",vec![json!(key),json!(backend),json!(profile)]).await?;
        Ok(())
    }
    pub async fn put_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Any>,
        key: &str,
        bytes: &[u8],
    ) -> anyhow::Result<()> {
        let (backend, profile) = self.upload(key, bytes).await?;
        self.db.tx_exec(tx,"INSERT INTO object_locations(object_key,backend,profile_id) VALUES(?,?,?) ON CONFLICT(object_key) DO UPDATE SET backend=excluded.backend,profile_id=excluded.profile_id",vec![json!(key),json!(backend),json!(profile)]).await?;
        Ok(())
    }
    async fn location(&self, key: &str) -> anyhow::Result<Option<S3Settings>> {
        Self::valid(key)?;
        if let Some(row) = self
            .db
            .one(
                "SELECT backend,profile_id FROM object_locations WHERE object_key=?",
                vec![json!(key)],
            )
            .await?
        {
            return match s(&row, "backend") {
                "local" => Ok(None),
                "s3" => Ok(Some(self.profile(s(&row, "profile_id")).await?)),
                _ => Ok(Some(self.default.clone())),
            };
        }
        if tokio::fs::try_exists(self.path.join(key)).await? || self.default.bucket.is_empty() {
            Ok(None)
        } else {
            Ok(Some(self.default.clone()))
        }
    }
    pub async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        if let Some(config) = self.location(key).await? {
            let r = config.client()?.get_object(key).await?;
            anyhow::ensure!(r.status_code() == 200, "Object unavailable");
            Ok(r.to_vec())
        } else {
            Ok(tokio::fs::read(self.path.join(key)).await?)
        }
    }
    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        if let Some(config) = self.location(key).await? {
            let r = config.client()?.delete_object(key).await?;
            anyhow::ensure!(
                r.status_code() < 300 || r.status_code() == 404,
                "S3 deletion failed"
            );
        } else {
            match tokio::fs::remove_file(self.path.join(key)).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        self.db
            .exec(
                "DELETE FROM object_locations WHERE object_key=?",
                vec![json!(key)],
            )
            .await?;
        Ok(())
    }
}
async fn load(state: &AppState, tenant: &str) -> anyhow::Result<(S3Settings, i64, bool)> {
    let row = state
        .db
        .one(
            "SELECT profile_id,revision FROM tenant_storage_configs WHERE tenant_id=?",
            vec![json!(tenant)],
        )
        .await?;
    match row {
        Some(row) if !s(&row, "profile_id").is_empty() => Ok((
            state.storage.profile(s(&row, "profile_id")).await?,
            n(&row, "revision"),
            true,
        )),
        Some(row) => Ok((S3Settings::default(), n(&row, "revision"), false)),
        None => Ok((
            S3Settings::from_config(&state.config),
            0,
            !state.config.s3_bucket.is_empty(),
        )),
    }
}
pub async fn settings(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.admin()?;
    let (c, r, enabled) = load(&state, &actor.tenant_id).await?;
    Ok(Json(
        json!({"config":c.public(),"revision":r,"enabled":enabled,"can_save":state.model_key.is_some()}),
    ))
}
#[derive(Deserialize)]
pub struct Input {
    pub enabled: bool,
    pub revision: i64,
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: Option<String>,
    pub region: String,
}
async fn merged(state: &AppState, actor: &Actor, i: &Input) -> Result<S3Settings> {
    let (old, _, _) = load(state, &actor.tenant_id).await?;
    let c = S3Settings {
        endpoint: i.endpoint.trim().trim_end_matches('/').into(),
        bucket: i.bucket.trim().into(),
        access_key: i.access_key.trim().into(),
        secret_key: i
            .secret_key
            .clone()
            .filter(|v| !v.is_empty())
            .unwrap_or(old.secret_key),
        region: if i.region.trim().is_empty() {
            "us-east-1".into()
        } else {
            i.region.trim().into()
        },
    };
    if i.enabled {
        let url = reqwest::Url::parse(&c.endpoint)
            .map_err(|_| AppError::bad("MinIO Endpoint 格式无效"))?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || c.bucket.len() < 3
            || c.bucket.len() > 63
            || !c
                .bucket
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
            || c.access_key.is_empty()
            || c.secret_key.is_empty()
        {
            return Err(AppError::bad(
                "请填写有效的 Endpoint、Bucket、Access Key 和 Secret Key",
            ));
        }
    }
    Ok(c)
}
async fn probe(c: &S3Settings) -> anyhow::Result<()> {
    let bucket = c.client()?;
    let key = format!("_connection-test/{}.txt", id());
    let data = b"atlas-minio-probe";
    let result = async {
        let r = bucket.put_object(&key, data).await?;
        anyhow::ensure!(r.status_code() < 300, "write failed");
        let r = bucket.get_object(&key).await?;
        anyhow::ensure!(r.status_code() == 200 && r.to_vec() == data, "read failed");
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let cleanup = bucket.delete_object(&key).await?;
    anyhow::ensure!(cleanup.status_code() < 300, "delete failed");
    result
}
pub async fn test(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<Input>,
) -> Result<Json<Value>> {
    actor.admin()?;
    if !input.enabled {
        return Err(AppError::bad("请先开启 MinIO"));
    }
    let c = merged(&state, &actor, &input).await?;
    match tokio::time::timeout(std::time::Duration::from_secs(30), probe(&c)).await {
        Ok(Ok(())) => Ok(Json(
            json!({"ok":true,"message":"MinIO 上传、读取、删除测试通过"}),
        )),
        _ => Err(AppError::bad(
            "MinIO 连接或读写失败，请检查地址、Bucket、凭据与读写删除权限",
        )),
    }
}
pub async fn save(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<Input>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let c = merged(&state, &actor, &input).await?;
    let payload = if input.enabled {
        Some(models::seal(&state, &actor.tenant_id, &c)?)
    } else {
        None
    };
    let mut tx = state.db.pool.begin().await?;
    state.db.tx_exec(&mut tx,"INSERT INTO tenant_storage_configs(tenant_id,revision,updated_at) VALUES(?,0,?) ON CONFLICT(tenant_id) DO NOTHING",vec![json!(actor.tenant_id),json!(now())]).await?;
    let profile = if let Some(payload) = payload {
        let profile = id();
        state
            .db
            .tx_exec(
                &mut tx,
                "INSERT INTO storage_profiles(id,tenant_id,payload,created_at) VALUES(?,?,?,?)",
                vec![
                    json!(profile),
                    json!(actor.tenant_id),
                    json!(payload),
                    json!(now()),
                ],
            )
            .await?;
        Some(profile)
    } else {
        None
    };
    let changed=state.db.tx_exec(&mut tx,"UPDATE tenant_storage_configs SET profile_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND revision=?",vec![json!(profile),json!(now()),json!(actor.tenant_id),json!(input.revision)]).await?;
    if changed != 1 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "配置已被更新，请刷新后重试".into(),
        ));
    }
    tx.commit().await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "storage.configure",
        None,
        json!({"enabled":input.enabled,"bucket":c.bucket}),
    )
    .await?;
    settings(State(state), actor).await
}
use axum::http::StatusCode;

pub async fn label(state: &AppState, tenant: &str) -> anyhow::Result<&'static str> {
    let (_, _, enabled) = load(state, tenant).await?;
    Ok(if enabled {
        "MinIO / S3"
    } else {
        "本地存储"
    })
}
