use serde_json::{json, Value};
use sqlx::{
    any::AnyPoolOptions, Acquire, Any, AnyPool, Column, Executor, Row, Transaction, TypeInfo,
    ValueRef,
};

#[derive(Clone)]
pub struct Db {
    pub pool: AnyPool,
    pub postgres: bool,
}
pub type Record = serde_json::Map<String, Value>;
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn s<'a>(row: &'a Record, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn n(row: &Record, key: &str) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or(0)
}
pub fn optional(row: &Record, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

impl Db {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        sqlx::any::install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(12)
            .after_connect(|conn, _| {
                Box::pin(async move {
                    if conn.backend_name() == "SQLite" {
                        conn.execute("PRAGMA foreign_keys=ON").await?;
                        conn.execute("PRAGMA busy_timeout=30000").await?;
                    }
                    Ok(())
                })
            })
            .connect(url)
            .await?;
        let db = Self {
            pool,
            postgres: url.starts_with("postgres"),
        };
        if !db.postgres {
            db.exec("PRAGMA journal_mode=WAL", vec![]).await?;
        }
        Ok(db)
    }
    pub fn sql(&self, input: &str) -> String {
        if !self.postgres {
            return input.to_owned();
        }
        let mut idx = 0;
        input
            .chars()
            .map(|c| {
                if c == '?' {
                    idx += 1;
                    format!("${idx}")
                } else {
                    c.to_string()
                }
            })
            .collect()
    }
    pub async fn migrate(&self, dimensions: usize, qdrant: bool) -> anyhow::Result<()> {
        // Serialize startup/migration across API and independent workers.
        let mut connection = self.pool.acquire().await?;
        if self.postgres {
            connection
                .execute("DO $$ BEGIN PERFORM pg_advisory_lock(7342901); END; $$")
                .await?;
        }
        sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/002_agent_metadata.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/003_studio.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!(
            "../migrations/004_storage_personal_vectors.sql"
        ))
        .execute(&mut *connection)
        .await?;
        sqlx::raw_sql(include_str!("../migrations/005_bot.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/006_bot_runtime.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/007_bot_messages.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/008_bot_devices.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/009_inspiration_game.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/010_bot_connections.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/011_harness.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/012_studio_inputs.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/013_bot_memory.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/014_bot_skill_review.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/015_bot_knowledge.sql"))
            .execute(&mut *connection)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/016_core_skill_registry.sql"))
            .execute(&mut *connection)
            .await?;
        // SQLite lacks ADD COLUMN IF NOT EXISTS. Serialize its column check and
        // ALTER in one write transaction; PostgreSQL already holds the advisory lock.
        let mut migration = connection.begin().await?;
        let skill_capture_exists = if self.postgres {
            sqlx::query("SELECT 1 AS present FROM pg_attribute WHERE attrelid='bot_memory_settings'::regclass AND attname='skill_capture' AND NOT attisdropped")
                .fetch_optional(&mut *migration).await?.is_some()
        } else {
            migration
                .execute("UPDATE schema_migrations SET applied_at=applied_at WHERE version=16")
                .await?;
            sqlx::query("PRAGMA table_info(bot_memory_settings)")
                .fetch_all(&mut *migration)
                .await?
                .iter()
                .any(|row| {
                    row.try_get::<String, _>("name")
                        .is_ok_and(|name| name == "skill_capture")
                })
        };
        if !skill_capture_exists {
            sqlx::raw_sql(include_str!("../migrations/017_skill_capture_settings.sql"))
                .execute(&mut *migration)
                .await?;
        }
        let registration = self.sql("INSERT INTO schema_migrations(version,applied_at) VALUES(17,?) ON CONFLICT(version) DO NOTHING");
        bind(&registration, vec![json!(now())])
            .execute(&mut *migration)
            .await?;
        migration.commit().await?;
        sqlx::raw_sql(include_str!("../migrations/018_bot_feishu.sql"))
            .execute(&mut *connection)
            .await?;
        let registration = self.sql("INSERT INTO schema_migrations(version,applied_at) VALUES(18,?) ON CONFLICT(version) DO NOTHING");
        bind(&registration, vec![json!(now())])
            .execute(&mut *connection)
            .await?;
        if self.postgres && !qdrant {
            connection
                .execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
                .await?;
            connection.execute(format!("ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_vector vector({dimensions})").as_str()).await?;
            connection.execute("CREATE INDEX IF NOT EXISTS ix_chunks_vector ON chunks USING hnsw (embedding_vector vector_cosine_ops)").await?;
        }
        if self.postgres {
            connection.execute("CREATE INDEX IF NOT EXISTS ix_chunks_fts ON chunks USING gin(to_tsvector('simple', search_tokens))").await?;
            connection
                .execute("DO $$ BEGIN PERFORM pg_advisory_unlock(7342901); END; $$")
                .await?;
        }
        if self.postgres && !qdrant {
            let column=self.one("SELECT format_type(atttypid,atttypmod) AS vector_type FROM pg_attribute WHERE attrelid='chunks'::regclass AND attname='embedding_vector'",vec![]).await?.ok_or_else(||anyhow::anyhow!("Vector column missing"))?;
            anyhow::ensure!(s(&column,"vector_type")==format!("vector({dimensions})"),"Configured embedding dimensions do not match the existing pgvector column. Migrate the column and HNSW index as documented in docs/deployment.md");
        }
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(2,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(3,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(4,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(5,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(6,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(7,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(8,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(9,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(10,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(11,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(12,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(13,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(14,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(15,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        self.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(16,?) ON CONFLICT(version) DO NOTHING", vec![json!(now())]).await?;
        Ok(())
    }
    pub async fn rows(&self, sql: &str, args: Vec<Value>) -> anyhow::Result<Vec<Record>> {
        let query = self.sql(sql);
        let rows = bind(&query, args).fetch_all(&self.pool).await?;
        rows.iter().map(convert).collect()
    }
    pub async fn one(&self, sql: &str, args: Vec<Value>) -> anyhow::Result<Option<Record>> {
        Ok(self.rows(sql, args).await?.into_iter().next())
    }
    pub async fn exec(&self, sql: &str, args: Vec<Value>) -> anyhow::Result<u64> {
        let query = self.sql(sql);
        Ok(bind(&query, args)
            .execute(&self.pool)
            .await?
            .rows_affected())
    }
    pub async fn tx_exec(
        &self,
        tx: &mut Transaction<'_, Any>,
        sql: &str,
        args: Vec<Value>,
    ) -> anyhow::Result<u64> {
        let query = self.sql(sql);
        Ok(bind(&query, args).execute(&mut **tx).await?.rows_affected())
    }
    pub async fn tx_one(
        &self,
        tx: &mut Transaction<'_, Any>,
        sql: &str,
        args: Vec<Value>,
    ) -> anyhow::Result<Option<Record>> {
        let query = self.sql(sql);
        let row = bind(&query, args).fetch_optional(&mut **tx).await?;
        row.as_ref().map(convert).transpose()
    }
}
fn bind(sql: &str, args: Vec<Value>) -> sqlx::query::Query<'_, Any, sqlx::any::AnyArguments<'_>> {
    let mut q = sqlx::query(sql);
    for arg in args {
        q = match arg {
            Value::Null => q.bind(Option::<String>::None),
            Value::String(v) => q.bind(v),
            Value::Number(v) if v.is_i64() => q.bind(v.as_i64().unwrap()),
            Value::Number(v) => q.bind(v.as_f64().unwrap()),
            Value::Bool(v) => q.bind(i64::from(v)),
            v => q.bind(v.to_string()),
        };
    }
    q
}
fn convert(row: &sqlx::any::AnyRow) -> anyhow::Result<Record> {
    let mut result = Record::new();
    for column in row.columns() {
        let key = column.name();
        let value = match row.try_get_raw(key)?.type_info().name() {
            "BIGINT" | "INTEGER" | "INT8" | "INT4" => row
                .try_get::<Option<i64>, _>(key)?
                .map(|v| json!(v))
                .unwrap_or(Value::Null),
            "REAL" | "DOUBLE" | "DOUBLE PRECISION" | "FLOAT8" => row
                .try_get::<Option<f64>, _>(key)?
                .map(|v| json!(v))
                .unwrap_or(Value::Null),
            "NULL" => Value::Null,
            _ => row
                .try_get::<Option<String>, _>(key)?
                .map(Value::String)
                .unwrap_or(Value::Null),
        };
        result.insert(key.to_owned(), value);
    }
    Ok(result)
}
