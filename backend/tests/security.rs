use atlas_server::{
    acl,
    auth::Actor,
    config::Config,
    db::{id, n, now, s},
    indexer,
    rag::{self, SearchInput},
    seed, AppState,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

struct Harness {
    state: AppState,
    router: Router,
    _temporary: TempDir,
}
impl Harness {
    async fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let mut config = Config::load().unwrap();
        config.production = false;
        // Local security fixtures must not inherit live service credentials from .env.
        // External storage tests opt in explicitly through ATLAS_TEST_S3_* below.
        config.s3_endpoint.clear();
        config.s3_bucket.clear();
        config.s3_access_key.clear();
        config.s3_secret_key.clear();
        config.memory_core_url.clear();
        config.memory_core_token.clear();
        config.memory_knowledge_url.clear();
        config.memory_knowledge_token.clear();
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temporary.path().join("test.db").display()
        );
        if let Ok(url) = std::env::var("ATLAS_TEST_DATABASE_URL") {
            let db = atlas_server::db::Db::connect(&url).await.unwrap();
            let schema = format!("test_{}", id().replace('-', ""));
            db.exec(&format!("CREATE SCHEMA {schema}"), vec![])
                .await
                .unwrap();
            db.pool.close().await;
            config.database_url = format!("{url}?options=-csearch_path%3D{schema}%2Cpublic");
        }
        if let Ok(endpoint) = std::env::var("ATLAS_TEST_S3_ENDPOINT") {
            config.s3_endpoint = endpoint;
            config.s3_bucket = "atlas-test".into();
            config.s3_access_key = std::env::var("ATLAS_TEST_S3_ACCESS_KEY").unwrap();
            config.s3_secret_key = std::env::var("ATLAS_TEST_S3_SECRET_KEY").unwrap();
        }
        config.qdrant_url = std::env::var("ATLAS_TEST_QDRANT_URL").unwrap_or_default();
        config.qdrant_collection_prefix = format!("test_{}", id().replace('-', ""));
        config.embedding_dimensions = 3;
        config.storage_path = temporary.path().join("files");
        config.seed_demo = true;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.ai_api_key.clear();
        config.vision_api_key.clear();
        config.chat_model.clear();
        config.vision_model.clear();
        config.embedding_model.clear();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        config.processor_python = root
            .join("processor/.venv/bin/python")
            .to_string_lossy()
            .into();
        config.processor_script = root.join("processor/extract.py").to_string_lossy().into();
        let state = AppState::new(config).await.unwrap();
        seed::initialize(&state).await.unwrap();
        let router = atlas_server::router(state.clone());
        Self {
            state,
            router,
            _temporary: temporary,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Value,
        credential: Option<&str>,
        origin: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(value) = credential {
            if value.starts_with("ak_") || value.starts_with("zd_") {
                request = request.header("authorization", format!("Bearer {value}"));
            } else {
                request = request.header("cookie", value);
            }
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = self
            .router
            .clone()
            .oneshot(
                request
                    .body(if method == "GET" {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value =
            serde_json::from_slice(&bytes).unwrap_or(json!(String::from_utf8_lossy(&bytes)));
        (status, value)
    }
    async fn login(&self, email: &str) -> String {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"tenant":"atlas","email":email,"password":"AtlasDemo123!"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }
    async fn actor(&self, email: &str) -> Actor {
        let u = self
            .state
            .db
            .one("SELECT * FROM users WHERE email=?", vec![json!(email)])
            .await
            .unwrap()
            .unwrap();
        Actor {
            id: s(&u, "id").into(),
            tenant_id: s(&u, "tenant_id").into(),
            department_id: s(&u, "department_id").into(),
            role: s(&u, "role").into(),
            scopes: None,
            key_id: None,
        }
    }
    async fn space(&self, name: &str) -> String {
        let space = self
            .state
            .db
            .one("SELECT id FROM spaces WHERE name=?", vec![json!(name)])
            .await
            .unwrap()
            .unwrap();
        s(&space, "id").into()
    }
    async fn index_all(&self) {
        while indexer::run_one(&self.state).await.unwrap() {}
        let failed = self
            .state
            .db
            .rows(
                "SELECT title,error FROM documents WHERE status!='ready'",
                vec![],
            )
            .await
            .unwrap();
        assert!(failed.is_empty(), "Indexing failures: {failed:?}");
    }
}

fn model_provider(enabled: bool, base: &str, model: &str, key: &str) -> Value {
    json!({"enabled":enabled,"base_url":base,"model":model,"api_key":key,"dimensions":3})
}

#[tokio::test]
async fn question_attachments_upload_index_scope_and_revoke() {
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let origin = Some("http://localhost:5173");
    let space = h.space("产品与研发").await;
    let body = format!("--question-file\r\nContent-Disposition: form-data; name=\"space_id\"\r\n\r\n{space}\r\n--question-file\r\nContent-Disposition: form-data; name=\"file\"; filename=\"release-notes.txt\"\r\nContent-Type: text/plain\r\n\r\n附件专属发布流程：由值班工程师确认回滚方案，发布前完成备份。\r\n--question-file--\r\n");
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/documents/upload")
                .header("cookie", &admin)
                .header("origin", "http://localhost:5173")
                .header(
                    "content-type",
                    "multipart/form-data; boundary=question-file",
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let document: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let doc = document["id"].as_str().unwrap();
    let (status, pending) = h
        .request(
            "GET",
            &format!("/api/documents/{doc}/status"),
            Value::Null,
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pending["status"], "queued");
    assert!(pending.get("chunks").is_none());
    let body = json!({"query":"概括核心要点","document_ids":[doc]});
    assert_eq!(
        h.request("POST", "/api/chat", body.clone(), Some(&admin), origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    h.index_all().await;
    let (status, answer) = h
        .request("POST", "/api/chat", body.clone(), Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    // No lexical overlap: introductory attachment evidence must still be available.
    assert!(answer["answer"].as_str().unwrap().contains("值班工程师"));
    assert!(!answer["citations"].as_array().unwrap().is_empty());
    assert!(answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["document_id"] == doc));
    let (_, found) = h
        .request(
            "POST",
            "/api/search",
            json!({"query":"发布流程","document_ids":[doc]}),
            Some(&admin),
            origin,
        )
        .await;
    assert!(!found["hits"].as_array().unwrap().is_empty());
    assert!(found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .all(|hit| hit["document_id"] == doc));
    let public = h.space("全员知识").await;
    assert_eq!(
        h.request(
            "POST",
            "/api/chat",
            json!({"query":"总结","document_ids":[doc],"space_id":public}),
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for ids in [json!([]), json!(vec![doc; 11])] {
        assert_eq!(
            h.request(
                "POST",
                "/api/chat",
                json!({"query":"总结","document_ids":ids}),
                Some(&admin),
                origin
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let member = h.login("zhou@atlas.local").await;
    assert_eq!(
        h.request(
            "GET",
            &format!("/api/documents/{doc}/status"),
            Value::Null,
            Some(&member),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.request("POST", "/api/chat", body.clone(), Some(&member), origin)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    h.state
        .db
        .exec(
            "UPDATE documents SET version=version+1 WHERE id=?",
            vec![json!(doc)],
        )
        .await
        .unwrap();
    assert_eq!(
        h.request("POST", "/api/chat", body, Some(&admin), origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (_, history) = h
        .request(
            "GET",
            &format!(
                "/api/conversations/{}/messages",
                answer["conversation_id"].as_str().unwrap()
            ),
            Value::Null,
            Some(&admin),
            None,
        )
        .await;
    assert!(history[1]["content"]
        .as_str()
        .unwrap()
        .contains("不再有访问权限"));
}

#[tokio::test]
async fn sqlite_storage_exhaustion_returns_actionable_error() {
    let temporary = tempfile::tempdir().unwrap();
    let db = atlas_server::db::Db::connect(&format!(
        "sqlite://{}?mode=rwc",
        temporary.path().join("full.db").display()
    ))
    .await
    .unwrap();
    let mut connection = db.pool.acquire().await.unwrap();
    sqlx::query("CREATE TABLE storage_probe(payload TEXT)")
        .execute(&mut *connection)
        .await
        .unwrap();
    // Constrain this connection's database pages instead of filling the host's disk.
    sqlx::query("PRAGMA max_page_count=2")
        .execute(&mut *connection)
        .await
        .unwrap();
    let error = sqlx::query("INSERT INTO storage_probe(payload) VALUES(?)")
        .bind("x".repeat(50_000))
        .execute(&mut *connection)
        .await
        .unwrap_err();
    let response = atlas_server::error::AppError::from(anyhow::Error::from(error));
    assert_eq!(response.0, StatusCode::INSUFFICIENT_STORAGE);
    assert!(response.1.contains("存储空间不足"));
    assert!(response.1.contains("释放"));
}

#[tokio::test]
async fn xlsx_upload_is_indexed_from_worker_temporary_path_and_is_searchable() {
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let space = h.space("全员知识").await;
    let mut body = format!("--atlas-xlsx\r\nContent-Disposition: form-data; name=\"space_id\"\r\n\r\n{space}\r\n--atlas-xlsx\r\nContent-Disposition: form-data; name=\"file\"; filename=\"daily-report.xlsx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n").into_bytes();
    body.extend_from_slice(include_bytes!("../../tests/fixtures/daily-report.xlsx"));
    body.extend_from_slice(b"\r\n--atlas-xlsx--\r\n");
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/documents/upload")
                .header("cookie", &admin)
                .header("origin", "http://localhost:5173")
                .header("content-type", "multipart/form-data; boundary=atlas-xlsx")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let document: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let id = document["id"].as_str().unwrap();
    h.index_all().await;
    let (status, indexed) = h
        .request(
            "GET",
            &format!("/api/documents/{id}"),
            json!(null),
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(indexed["document"]["status"], "ready", "{indexed}");
    let (status, results) = h
        .request(
            "POST",
            "/api/search",
            json!({"query":"发电量","space_id":space}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let hits = results["hits"].as_array().unwrap();
    let hit = hits
        .iter()
        .find(|hit| hit["document_id"] == id)
        .expect("Uploaded XLSX must be searchable");
    assert_eq!(hit["kind"], "table");
    assert_eq!(hit["page"], 1);
    assert!(hit["text"].as_str().unwrap().contains("1250.5"));
}
fn model_settings(base: &str, revision: i64) -> Value {
    json!({"revision":revision,"chat":model_provider(true,base,"test-chat","chat-secret"),
        "embedding":model_provider(true,base,"test-embedding","embedding-secret"),
        "vision":model_provider(true,base,"test-vision","vision-secret")})
}

#[tokio::test]
async fn monthly_retrieval_covers_all_stations_filters_dates_and_preserves_acl() {
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let space = h.space("产品与研发").await;
    let title = "国烁能源2025年11月日报.xlsx";
    let mut bytes = format!("--monthly\r\nContent-Disposition: form-data; name=\"space_id\"\r\n\r\n{space}\r\n--monthly\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{title}\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n").into_bytes();
    bytes.extend_from_slice(include_bytes!("../../tests/fixtures/monthly-report.xlsx"));
    bytes.extend_from_slice(b"\r\n--monthly--\r\n");
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/documents/upload")
                .header("cookie", &admin)
                .header("origin", "http://localhost:5173")
                .header("content-type", "multipart/form-data; boundary=monthly")
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let document: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let doc = document["id"].as_str().unwrap();
    for month in [10, 12] {
        assert_eq!(h.request("POST","/api/documents",json!({"space_id":space,"title":format!("国烁能源2025年{month}月日报"),"content":"11月各场站日报汇总 甲站：错误月份99999"}),Some(&admin),Some("http://localhost:5173")).await.0,StatusCode::OK);
    }
    h.index_all().await;
    let (_, found) = h
        .request(
            "POST",
            "/api/search",
            json!({"query":"国烁能源集团11月各场站的日报数据汇总一下给我"}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    let hits = found["hits"].as_array().unwrap();
    assert!(!hits.is_empty(), "{found}");
    assert!(hits.iter().all(|v| v["document_id"] == doc));
    assert_eq!(hits[0]["kind"], "table_summary");
    let summary = hits[0]["text"].as_str().unwrap();
    assert!(summary.contains("甲站 | 240 | 80%"), "{summary}");
    assert!(summary.contains("乙站 | 270 | 120%"));
    // Report rows are not character-split, even when notes exceed 900 chars.
    let (_, data) = h
        .request(
            "GET",
            &format!("/api/documents/{doc}"),
            json!(null),
            Some(&admin),
            None,
        )
        .await;
    assert!(data["chunks"].as_array().unwrap().iter().any(|r| r["text"]
        .as_str()
        .unwrap()
        .contains("- 场站：甲站")
        && r["text"].as_str().unwrap().chars().count() > 900));
    for query in ["国烁能源2025-11-30发电量", "国烁能源11月30日发电量"] {
        let (_, found) = h
            .request(
                "POST",
                "/api/search",
                json!({"query":query}),
                Some(&admin),
                Some("http://localhost:5173"),
            )
            .await;
        let hits = found["hits"].as_array().unwrap();
        assert!(!hits.is_empty(), "{found}");
        assert!(
            hits.iter().all(|r| r["kind"] != "table_summary"
                && r["text"].as_str().unwrap().contains("日期：2025-11-30")),
            "{found}"
        );
    }
    let member = h.actor("wang@atlas.local").await;
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view,effect) VALUES(?,?,'user',?,1,'deny')",vec![json!(id()),json!(space),json!(member.id)]).await.unwrap();
    let input = SearchInput {
        query: "国烁能源11月日报汇总".into(),
        space_id: None,
        limit: Some(20),
        document_ids: None,
        image_base64: None,
        image_mime: None,
    };
    assert!(rag::search(&h.state, &member, input)
        .await
        .unwrap()
        .hits
        .iter()
        .all(|r| r["document_id"] != doc));
    h.state
        .db
        .exec(
            "UPDATE documents SET version=version+1 WHERE id=?",
            vec![json!(doc)],
        )
        .await
        .unwrap();
    let (_, stale) = h
        .request(
            "POST",
            "/api/search",
            json!({"query":"国烁能源11月日报汇总"}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    assert!(stale["hits"].as_array().unwrap().is_empty(), "{stale}");
}

#[tokio::test]
async fn model_settings_are_encrypted_tenant_scoped_and_survive_restart() {
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.login("wang@atlas.local").await;
    let origin = Some("http://localhost:5173");
    assert_eq!(
        h.request("GET", "/api/models", json!(null), Some(&member), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let body = model_settings("http://127.0.0.1:9999/v1", 0);
    assert_eq!(
        h.request("PUT", "/api/models", body.clone(), Some(&member), origin)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.request(
            "POST",
            "/api/models/test",
            json!({"revision":0,"kind":"chat","config":body["chat"]}),
            Some(&member),
            origin
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.request(
            "PUT",
            "/api/models",
            body.clone(),
            Some(&admin),
            Some("https://evil.example")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = h
        .request("PUT", "/api/models", body.clone(), Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["chat"]["has_api_key"], true);
    assert!(!saved.to_string().contains("chat-secret"));
    assert!(saved["chat"].get("api_key").is_none());
    let tenant = h.actor("admin@atlas.local").await.tenant_id;
    let stored = h
        .state
        .db
        .one(
            "SELECT payload FROM tenant_model_configs WHERE tenant_id=?",
            vec![json!(tenant)],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!s(&stored, "payload").contains("secret"));
    assert!(!s(&stored, "payload").contains("test-chat"));
    let audit = h
        .request("GET", "/api/audit", json!(null), Some(&admin), None)
        .await
        .1;
    assert!(!audit.to_string().contains("chat-secret"));
    assert_eq!(
        h.request("PUT", "/api/models", body.clone(), Some(&admin), origin)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let restarted = AppState::new(h.state.config.as_ref().clone())
        .await
        .unwrap();
    let applied = restarted.for_tenant(&tenant).await.unwrap();
    assert_eq!(applied.config.chat_api_key, "chat-secret");
    assert!(applied.config.embeddings());
    assert!(applied.for_tenant("another-tenant").await.is_err());
    let other = restarted.for_tenant("another-tenant").await.unwrap();
    assert!(!other.config.chat());
    assert!(other.config.chat_api_key.is_empty());
    // Authenticated encryption binds ciphertext to the tenant as well as the encryption key.
    h.state
        .db
        .exec(
            "INSERT INTO tenants(id,slug,name) VALUES('another-tenant','other-models','Other')",
            vec![],
        )
        .await
        .unwrap();
    h.state.db.exec("INSERT INTO tenant_model_configs(tenant_id,payload,revision,updated_at) VALUES('another-tenant',?,1,?)",vec![json!(s(&stored,"payload")),json!(now())]).await.unwrap();
    assert!(restarted.for_tenant("another-tenant").await.is_err());
    let wrong_key = AppState {
        model_key: Some(std::sync::Arc::new([7; 32])),
        ..restarted.clone()
    };
    assert!(wrong_key.for_tenant(&tenant).await.is_err());
    let mut keep = body.clone();
    keep["revision"] = json!(1);
    for kind in ["chat", "embedding", "vision"] {
        keep[kind].as_object_mut().unwrap().remove("api_key");
    }
    let (status, _) = h
        .request("PUT", "/api/models", keep.clone(), Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        h.state
            .for_tenant(&tenant)
            .await
            .unwrap()
            .config
            .chat_api_key,
        "chat-secret"
    );
    keep["revision"] = json!(2);
    keep["chat"]["clear_api_key"] = json!(true);
    keep["embedding"]["enabled"] = json!(false);
    assert_eq!(
        h.request("PUT", "/api/models", keep, Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    let fresh = h.state.for_tenant(&tenant).await.unwrap();
    assert!(fresh.config.chat_api_key.is_empty());
    assert!(!fresh.config.embeddings());
    let mut invalid = body;
    invalid["revision"] = json!(3);
    invalid["chat"]["base_url"] = json!("file:///etc/passwd");
    assert_eq!(
        h.request("PUT", "/api/models", invalid, Some(&admin), origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (status, key) = h
        .request(
            "POST",
            "/api/keys",
            json!({"name":"models admin blocked","scopes":["search.read"],"expires_days":1}),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        h.request("GET", "/api/models", json!(null), key["key"].as_str(), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn model_probes_validate_actual_calls_and_unsaved_configuration() {
    use axum::{http::HeaderMap, routing::post};
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let provider = Router::new()
        .route("/v1/chat/completions",post(|headers:HeaderMap,axum::Json(input):axum::Json<Value>|async move {
            let vision = input["model"]=="test-vision";
            assert_eq!(headers["authorization"],if vision {"Bearer vision-secret"}else{"Bearer chat-secret"});
            if vision {
                let image=input["messages"][0]["content"][1]["image_url"]["url"].as_str().unwrap();
                assert!(image.starts_with("data:image/png;base64,"));
            }
            if input["model"]=="empty" {axum::Json(json!({"choices":[]}))} else {axum::Json(json!({"choices":[{"message":{"content":"连接成功"}}]}))}
        }))
        .route("/v1/embeddings",post(|headers:HeaderMap,axum::Json(input):axum::Json<Value>|async move {
            assert_eq!(headers["authorization"],"Bearer embedding-secret");
            axum::Json(json!({"data":[{"index":0,"embedding":if input["model"]=="zero"{vec![0.0,0.0,0.0]}else{vec![1.0,0.0,0.0]}}]}))
        }))
        .route("/unauthorized/chat/completions",post(||async {(StatusCode::UNAUTHORIZED,axum::Json(json!({"error":"upstream reflects chat-secret"})))}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let body = model_settings(&format!("http://{address}/v1"), 0);
    for kind in ["chat", "embedding", "vision"] {
        let (status, result) = h
            .request(
                "POST",
                "/api/models/test",
                json!({"revision":0,"kind":kind,"config":body[kind]}),
                Some(&admin),
                Some("http://localhost:5173"),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["success"], true, "{result}");
    }
    assert_eq!(
        h.request("GET", "/api/models", json!(null), Some(&admin), None)
            .await
            .1["revision"],
        0
    );
    let mut input = json!({"revision":0,"kind":"embedding","config":body["embedding"]});
    input["config"]["dimensions"] = json!(2);
    let result = h
        .request(
            "POST",
            "/api/models/test",
            input.clone(),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await
        .1;
    assert_eq!(result["success"], false);
    assert!(result["message"].as_str().unwrap().contains("实际返回 3"));
    input["config"]["dimensions"] = json!(3);
    input["config"]["model"] = json!("zero");
    assert_eq!(
        h.request(
            "POST",
            "/api/models/test",
            input,
            Some(&admin),
            Some("http://localhost:5173")
        )
        .await
        .1["success"],
        false
    );
    let mut chat = body["chat"].clone();
    chat["base_url"] = json!(format!("http://{address}/unauthorized"));
    let failure = h
        .request(
            "POST",
            "/api/models/test",
            json!({"revision":0,"kind":"chat","config":chat}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await
        .1;
    assert_eq!(failure["success"], false);
    assert!(failure["message"].as_str().unwrap().contains("401"));
    assert!(!failure.to_string().contains("chat-secret"));
    chat = body["chat"].clone();
    chat["model"] = json!("empty");
    assert_eq!(
        h.request(
            "POST",
            "/api/models/test",
            json!({"revision":0,"kind":"chat","config":chat}),
            Some(&admin),
            Some("http://localhost:5173")
        )
        .await
        .1["success"],
        false
    );
    task.abort();
}

#[tokio::test]
async fn saved_model_settings_drive_indexing_retrieval_and_answers_without_restart() {
    use axum::{http::HeaderMap, routing::post};
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let provider = Router::new().route("/v1/embeddings",post(|headers:HeaderMap,axum::Json(input):axum::Json<Value>|async move {
        assert_eq!(headers["authorization"],"Bearer embedding-secret");
        assert_eq!(input["model"],"test-embedding");
        let data = input["input"].as_array().unwrap().iter().enumerate().map(|(i,_)|json!({"index":i,"embedding":[1.0,0.0,0.0]})).collect::<Vec<_>>();
        axum::Json(json!({"data":data}))
    })).route("/v1/chat/completions",post(|headers:HeaderMap,axum::Json(input):axum::Json<Value>|async move {
        assert_eq!(headers["authorization"],"Bearer chat-secret");
        assert_eq!(input["model"],"test-chat");
        axum::Json(json!({"choices":[{"message":{"content":"已从页面配置的模型生成答案 [1]"}}]}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let origin = Some("http://localhost:5173");
    let body = model_settings(&format!("http://{address}/v1"), 0);
    assert_eq!(
        h.request("PUT", "/api/models", body.clone(), Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    h.index_all().await;
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"报销"}),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["mode"], "hybrid");
    assert!(answer["answer"].as_str().unwrap().contains("页面配置"));
    let stats = h
        .request("GET", "/api/stats", json!(null), Some(&admin), None)
        .await
        .1;
    assert_eq!(stats["capabilities"]["semantic"], true);
    // Same model name at a different provider must not reuse old vectors.
    let tenant = h.actor("admin@atlas.local").await.tenant_id;
    let previous = h.state.for_tenant(&tenant).await.unwrap();
    let mut changed = body;
    changed["revision"] = json!(1);
    changed["embedding"]["base_url"] = json!(format!("http://{address}/other-v1"));
    assert_eq!(
        h.request("PUT", "/api/models", changed.clone(), Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    assert_ne!(
        h.state
            .for_tenant(&tenant)
            .await
            .unwrap()
            .config
            .embedding_identity(),
        previous.config.embedding_identity()
    );
    changed["revision"] = json!(2);
    changed["chat"]["enabled"] = json!(false);
    changed["embedding"]["enabled"] = json!(false);
    assert_eq!(
        h.request("PUT", "/api/models", changed, Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"报销"}),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(answer["mode"], "keyword");
    assert!(answer["answer"].as_str().unwrap().contains("原文片段"));
    assert!(answer["answer"].as_str().unwrap().contains("未启用"));
    assert!(!answer["answer"]
        .as_str()
        .unwrap()
        .contains("未配置问答模型"));
    let stats = h
        .request("GET", "/api/stats", json!(null), Some(&admin), None)
        .await
        .1;
    assert_eq!(stats["capabilities"]["chat"], false);
    assert_eq!(stats["capabilities"]["models"]["chat"], "test-chat");
    let mut enable = model_settings(&format!("http://{address}/v1"), 3);
    enable["embedding"]["enabled"] = json!(false);
    // Blank keys retain saved credentials when switching the configured model back on.
    enable["chat"].as_object_mut().unwrap().remove("api_key");
    assert_eq!(
        h.request("PUT", "/api/models", enable, Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"报销"}),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(answer["answer"].as_str().unwrap().contains("页面配置"));
    task.abort();
}

#[tokio::test]
async fn inherited_acl_explicit_denial_and_create_only_are_enforced() {
    let h = Harness::new().await;
    let actor = h.actor("wang@atlas.local").await;
    let eng = h.space("产品与研发").await;
    let hr = h.space("人力与行政").await;
    let rights = acl::all_rights(&h.state, &actor).await.unwrap();
    assert!(rights[&eng].can_view && rights[&eng].can_create);
    assert!(!rights[&hr].can_view);
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view,effect) VALUES(?,?,'user',?,1,'deny')",vec![json!(id()),json!(eng),json!(actor.id)]).await.unwrap();
    let rights = acl::all_rights(&h.state, &actor).await.unwrap();
    assert!(!rights[&eng].can_view);
    assert!(rights[&eng].can_create);
    let cookie = h.login("wang@atlas.local").await;
    let(status,body)=h.request("POST","/api/documents",json!({"space_id":eng,"title":"仅创建授权的提交","content":"成员可以提交，但不能查看本空间的其他内容"}),Some(&cookie),Some("http://localhost:5173")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = h
        .request(
            "GET",
            &format!("/api/documents/{}", body["id"].as_str().unwrap()),
            Value::Null,
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = h
        .request(
            "GET",
            &format!("/api/documents?space_id={hr}"),
            Value::Null,
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
#[tokio::test]
async fn search_citations_history_and_downloads_respect_current_permissions() {
    let h = Harness::new().await;
    h.index_all().await;
    let cookie = h.login("wang@atlas.local").await;
    let eng = h.space("产品与研发").await;
    let actor = h.actor("wang@atlas.local").await;
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"产品需求评审","space_id":eng}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(!answer["citations"].as_array().unwrap().is_empty());
    let doc = answer["citations"][0]["document_id"].as_str().unwrap();
    let conversation = answer["conversation_id"].as_str().unwrap();
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view,effect) VALUES(?,?,'user',?,1,'deny')",vec![json!(id()),json!(eng),json!(actor.id)]).await.unwrap();
    let (status, history) = h
        .request(
            "GET",
            &format!("/api/conversations/{conversation}/messages"),
            Value::Null,
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(history[1]["content"]
        .as_str()
        .unwrap()
        .contains("不再有访问权限"));
    assert_eq!(history[1]["citations"], json!([]));
    let (status, _) = h
        .request(
            "GET",
            &format!("/api/documents/{doc}/file"),
            Value::Null,
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let hr = h.space("人力与行政").await;
    let result = rag::search(
        &h.state,
        &actor,
        SearchInput {
            query: "绩效培养发布需求评审".into(),
            space_id: None,
            limit: Some(20),
            document_ids: None,
            image_base64: None,
            image_mime: None,
        },
    )
    .await
    .unwrap();
    assert!(result
        .hits
        .iter()
        .all(|c| c["space_id"] != eng && c["space_id"] != hr));
}
#[tokio::test]
async fn api_key_scopes_revoke_and_csrf_apply_to_mcp_and_rest() {
    let h = Harness::new().await;
    let cookie = h.login("admin@atlas.local").await;
    let (status, _) = h
        .request(
            "POST",
            "/api/keys",
            json!({"name":"bad-origin","scopes":["search.read"]}),
            Some(&cookie),
            Some("https://evil.example"),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = h
        .request(
            "POST",
            "/api/keys",
            json!({"name":"missing-origin","scopes":["search.read"]}),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, key) = h
        .request(
            "POST",
            "/api/keys",
            json!({"name":"readonly agent","scopes":["search.read"],"expires_days":30}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{key}");
    let secret = key["key"].as_str().unwrap();
    let(status,init)=h.request("POST","/mcp",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),Some(secret),None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let (_, tools) = h
        .request(
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            Some(secret),
            None,
        )
        .await;
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"] == "knowledge_search"));
    assert!(!tools.iter().any(|t| t["name"] == "knowledge_create"));
    let (status, _) = h
        .request(
            "POST",
            "/api/documents",
            json!({"space_id":h.space("全员知识").await,"title":"forbidden","content":"forbidden"}),
            Some(secret),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let(_,call)=h.request("POST","/mcp",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"knowledge_create","arguments":{"space_id":h.space("全员知识").await,"title":"forbidden","content":"forbidden"}}}),Some(secret),None).await;
    assert_eq!(call["result"]["isError"], true);
    let (status, _) = h
        .request(
            "DELETE",
            &format!("/api/keys/{}", key["id"].as_str().unwrap()),
            json!({}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = h
        .request(
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":4,"method":"ping"}),
            Some(secret),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn tenant_ids_cannot_be_used_to_cross_access_boundaries() {
    let h = Harness::new().await;
    let cookie = h.login("admin@atlas.local").await;
    let other = id();
    let space = id();
    let actor = h.actor("admin@atlas.local").await;
    h.state
        .db
        .exec(
            "INSERT INTO tenants(id,slug,name) VALUES(?,'other','Other')",
            vec![json!(other)],
        )
        .await
        .unwrap();
    h.state.db.exec("INSERT INTO spaces(id,tenant_id,name,created_by,created_at) VALUES(?,?,'Other secret',?,?)",vec![json!(space),json!(other),json!(actor.id),json!(now())]).await.unwrap();
    let (status, _) = h
        .request(
            "POST",
            "/api/documents",
            json!({"space_id":space,"title":"cross tenant","content":"should fail"}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = h
        .request(
            "PUT",
            &format!("/api/spaces/{space}/grants"),
            json!([]),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let department = h
        .state
        .db
        .one("SELECT id FROM departments LIMIT 1", vec![])
        .await
        .unwrap()
        .unwrap();
    let (status, _) = h
        .request(
            "POST",
            "/api/departments",
            json!({"name":"Normal child","parent_id":s(&department,"id")}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}
#[tokio::test]
async fn stale_version_jobs_are_superseded_without_publishing() {
    let h = Harness::new().await;
    let doc = h
        .state
        .db
        .one("SELECT * FROM documents LIMIT 1", vec![])
        .await
        .unwrap()
        .unwrap();
    let key = s(&doc, "id");
    h.state
        .db
        .exec(
            "UPDATE documents SET version=2 WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    while indexer::run_one(&h.state).await.unwrap() {}
    let job = h
        .state
        .db
        .one(
            "SELECT status FROM index_jobs WHERE document_id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&job, "status"), "superseded");
    let chunks = h
        .state
        .db
        .one(
            "SELECT COUNT(*) AS count FROM chunks WHERE document_id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n(&chunks, "count"), 0);
}
#[tokio::test]
async fn multimodal_pipeline_indexes_images_and_supports_text_and_image_queries() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut h = Harness::new().await;
    let provider=Router::new().route("/v1/embeddings",axum::routing::post(|axum::Json(input):axum::Json<Value>|async move {
        let items=input["input"].as_array().unwrap().iter().enumerate().map(|(i,text)|json!({"index":i,"embedding":if text.as_str().unwrap().contains("疏散"){vec![1.0,0.0,0.0]}else{vec![0.0,1.0,0.0]}})).collect::<Vec<_>>();axum::Json(json!({"data":items}))
    })).route("/v1/chat/completions",axum::routing::post(|axum::Json(input):axum::Json<Value>|async move {
        assert_eq!(input["model"],"test-vision");assert!(input["messages"][1]["content"][1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/"));
        axum::Json(json!({"choices":[{"message":{"content":"仓库安全疏散路线图，仓库经箭头连接到紧急出口 Exit。"}}]}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let config = std::sync::Arc::make_mut(&mut h.state.config);
    config.ai_base_url = format!("http://{address}/v1");
    config.ai_api_key = "test-key".into();
    config.embedding_model = "test-embedding".into();
    config.embedding_dimensions = 3;
    config.vision_model = "test-vision".into();
    h.router = atlas_server::router(h.state.clone());
    let cookie = h.login("admin@atlas.local").await;
    let space = h.space("全员知识").await;
    let mut body=format!("--atlas-test\r\nContent-Disposition: form-data; name=\"space_id\"\r\n\r\n{space}\r\n--atlas-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"warehouse.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(include_bytes!("../../tests/fixtures/diagram.png"));
    body.extend_from_slice(b"\r\n--atlas-test--\r\n");
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/documents/upload")
                .header("cookie", &cookie)
                .header("origin", "http://localhost:5173")
                .header("content-type", "multipart/form-data; boundary=atlas-test")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    h.index_all().await;
    let actor = h.actor("admin@atlas.local").await;
    for input in [
        SearchInput {
            query: "仓库疏散路线".into(),
            space_id: Some(space.clone()),
            limit: Some(6),
            document_ids: None,
            image_base64: None,
            image_mime: None,
        },
        SearchInput {
            query: String::new(),
            space_id: Some(space.clone()),
            limit: Some(6),
            document_ids: None,
            image_base64: Some(STANDARD.encode(include_bytes!("../../tests/fixtures/diagram.png"))),
            image_mime: Some("image/png".into()),
        },
    ] {
        let result = rag::search(&h.state, &actor, input).await.unwrap();
        assert_eq!(result.mode, "hybrid");
        let image = result
            .hits
            .iter()
            .find(|h| h["kind"] == "image")
            .expect("Image must be retrieved by text and image query");
        assert_eq!(image["page"], 1);
        assert!(image["text"].as_str().unwrap().contains("紧急出口"));
        let response = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(image["image_url"].as_str().unwrap())
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/jpeg");
    }
    task.abort();
}
#[tokio::test]
async fn reporting_hierarchy_and_cycle_rejection_work() {
    let h = Harness::new().await;
    let lead = h.actor("lin@atlas.local").await;
    let member = h.actor("wang@atlas.local").await;
    let space = h.space("人力与行政").await;
    let admin = h.actor("admin@atlas.local").await;
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,include_descendants,can_view) VALUES(?,?,'reports',?,1,1)",vec![json!(id()),json!(space),json!(admin.id)]).await.unwrap();
    assert!(acl::all_rights(&h.state, &member).await.unwrap()[&space].can_view);
    assert!(acl::all_rights(&h.state, &lead).await.unwrap()[&space].can_view);
    h.state
        .db
        .exec(
            "UPDATE grants SET include_descendants=0 WHERE space_id=? AND principal_type='reports'",
            vec![json!(space)],
        )
        .await
        .unwrap();
    assert!(!acl::all_rights(&h.state, &member).await.unwrap()[&space].can_view);
    assert!(acl::all_rights(&h.state, &lead).await.unwrap()[&space].can_view);
    let cookie = h.login("admin@atlas.local").await;
    let departments = h
        .state
        .db
        .rows(
            "SELECT * FROM departments WHERE parent_id IS NOT NULL",
            vec![],
        )
        .await
        .unwrap();
    let child = &departments[0];
    let (status, _) = h
        .request(
            "PUT",
            &format!("/api/departments/{}", s(child, "parent_id")),
            json!({"name":"产品研发中心","parent_id":s(child,"id")}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = h
        .request(
            "PUT",
            &format!("/api/users/{}", lead.id),
            json!({"name":"林沐","role":"member","active":true,"manager_id":member.id}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
#[tokio::test]
async fn aggregate_counts_pagination_and_login_throttling_are_real() {
    let h = Harness::new().await;
    let cookie = h.login("admin@atlas.local").await;
    let (status, docs) = h
        .request(
            "GET",
            "/api/documents?limit=2",
            Value::Null,
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(docs["total"], 8);
    assert_eq!(docs["items"].as_array().unwrap().len(), 2);
    let (_, stats) = h
        .request("GET", "/api/stats", Value::Null, Some(&cookie), None)
        .await;
    assert_eq!(stats["counts"]["documents"], 8);
    assert_eq!(stats["counts"]["pending"], 8);
    for _ in 0..10 {
        let (status, _) = h
            .request(
                "POST",
                "/api/auth/login",
                json!({"tenant":"atlas","email":"bad@atlas.local","password":"bad-password"}),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = h
        .request(
            "POST",
            "/api/auth/login",
            json!({"tenant":"atlas","email":"bad@atlas.local","password":"bad-password"}),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}
#[tokio::test]
async fn two_workers_claim_distinct_jobs_and_deleted_docs_leave_no_search_content() {
    let h = Harness::new().await;
    let (left, right) = tokio::join!(
        async {
            while indexer::run_one(&h.state).await? {}
            Ok::<(), anyhow::Error>(())
        },
        async {
            while indexer::run_one(&h.state).await? {}
            Ok::<(), anyhow::Error>(())
        }
    );
    left.unwrap();
    right.unwrap();
    let jobs = h
        .state
        .db
        .rows("SELECT status,attempts FROM index_jobs", vec![])
        .await
        .unwrap();
    assert_eq!(jobs.len(), 8);
    assert!(jobs
        .iter()
        .all(|r| s(r, "status") == "done" && n(r, "attempts") == 1));
    let cookie = h.login("admin@atlas.local").await;
    let (_, found) = h
        .request(
            "POST",
            "/api/search",
            json!({"query":"报销流程"}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    let doc = found["hits"][0]["document_id"].as_str().unwrap();
    let (status, _) = h
        .request(
            "DELETE",
            &format!("/api/documents/{doc}"),
            json!({}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = h
        .request(
            "GET",
            &format!("/api/documents/{doc}/file"),
            Value::Null,
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, found) = h
        .request(
            "POST",
            "/api/search",
            json!({"query":"报销流程"}),
            Some(&cookie),
            Some("http://localhost:5173"),
        )
        .await;
    assert!(found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .all(|h| h["document_id"] != doc));
}

#[tokio::test]
async fn vision_retries_rate_limits_but_not_auth_errors_and_bounds_retries() {
    use axum::response::IntoResponse;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let mut h = Harness::new().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let provider = Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |axum::Json(input): axum::Json<Value>| {
            let calls = observed.clone();
            async move {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                match input["model"].as_str().unwrap() {
                    "auth-failure" => StatusCode::UNAUTHORIZED.into_response(),
                    "always-limited" => {
                        (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "1")]).into_response()
                    }
                    "retry-image" if attempt == 0 => {
                        (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "1")]).into_response()
                    }
                    "retry-image" => {
                        axum::Json(json!({"choices":[{"message":{"content":"幻灯片文字"}}]}))
                            .into_response()
                    }
                    _ => panic!("Unexpected model"),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let config = Arc::make_mut(&mut h.state.config);
    config.vision_base_url = format!("http://{address}/v1");
    config.vision_model = "retry-image".into();
    let started = std::time::Instant::now();
    let result = atlas_server::ai::vision(&h.state, b"image", "image/png")
        .await
        .unwrap();
    assert_eq!(result, "幻灯片文字");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(started.elapsed() >= std::time::Duration::from_secs(1));
    calls.store(0, Ordering::SeqCst);
    Arc::make_mut(&mut h.state.config).vision_model = "auth-failure".into();
    let error = atlas_server::ai::vision(&h.state, b"image", "image/png")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("401"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    calls.store(0, Ordering::SeqCst);
    Arc::make_mut(&mut h.state.config).vision_model = "always-limited".into();
    let error = atlas_server::ai::vision(&h.state, b"image", "image/png")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("429"));
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    task.abort();
}

#[tokio::test]
async fn pi_agent_tools_preserve_acl_scope_history_and_web_metadata() {
    use axum::response::IntoResponse;
    use std::sync::{Arc, Mutex};
    let mut h = Harness::new().await;
    h.index_all().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.login("zhou@atlas.local").await;
    let space = h.space("全员知识").await;
    let hidden = h.state.db.one("SELECT d.id,d.space_id FROM documents d JOIN spaces s ON d.space_id=s.id WHERE s.name='产品与研发' LIMIT 1",vec![]).await.unwrap().unwrap();
    let hidden_id = s(&hidden, "id").to_owned();
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let requests = observed.clone();
    let provider = Router::new().route("/v1/chat/completions",axum::routing::post(move |axum::Json(input):axum::Json<Value>| {
        let observed = requests.clone();let hidden = hidden_id.clone();
        async move {
            observed.lock().unwrap().push(input.clone());
            let last = input["messages"].as_array().unwrap().last().unwrap();
            let content = &input["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="user").unwrap()["content"];
            let current = content.as_str().map(str::to_owned).unwrap_or_else(||content.as_array().unwrap().iter().filter_map(|v|v["text"].as_str()).collect::<Vec<_>>().join("\n"));
            let tool = if last["role"]=="tool" { None }
                else if current.contains("越权") { Some(("knowledge_read",json!({"document_id":hidden}))) }
                else if current.contains("联网") { Some(("web_search",json!({"query":"PostgreSQL documentation"}))) }
                else if current.contains("内网") { Some(("web_fetch",json!({"url":"http://169.254.169.254/latest/meta-data"}))) }
                else {Some(("knowledge_search",json!({"query":"差旅报销","limit":3})))};
            let delta = if let Some((name,args)) = tool { json!({"role":"assistant","tool_calls":[{"index":0,"id":"call-one","type":"function","function":{"name":name,"arguments":args.to_string()}}]}) }
                else {json!({"role":"assistant","content":if current.contains("联网"){"外部公开资料可查看 [W1]。"}else if current.contains("越权")||current.contains("内网"){"没有访问权限，不能读取该资料。"}else{"根据授权资料回答。[1]"}})};
            let finish = if delta["tool_calls"].is_array(){"tool_calls"}else{"stop"};
            let body = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),json!({"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}]}));
            ([("content-type","text/event-stream")],body).into_response()
        }
    })).route("/search",axum::routing::get(||async {axum::Json(json!({"results":[{"title":"PostgreSQL documentation","url":"https://www.postgresql.org/docs/","content":"Public database documentation"}]}))}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let config = Arc::make_mut(&mut h.state.config);
    config.agent_enabled = true;
    config.ai_base_url = format!("http://{address}/v1");
    config.ai_api_key = "fixture-key".into();
    config.chat_model = "fixture-agent".into();
    config.web_search_url = format!("http://{address}/search");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    config.agent_script = root.join("agent-runtime/agent.mjs").display().to_string();
    h.router = atlas_server::router(h.state.clone());
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"差旅报销","space_id":space}),
            Some(&member),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["engine"], "pi-agent-core");
    assert_eq!(answer["tool_calls"][0]["name"], "knowledge_search");
    assert_eq!(answer["tool_calls"][0]["success"], true);
    assert!(!answer["citations"].as_array().unwrap().is_empty());
    assert_eq!(answer["citations"][0]["citation_number"], 1);
    assert_eq!(answer["citations"][0]["referenced"], true);
    assert!(observed.lock().unwrap()[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| !t["function"]["name"].as_str().unwrap().starts_with("web_")));
    let conversation = answer["conversation_id"].as_str().unwrap();
    let (status, _) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"继续解释报销流程","conversation_id":conversation}),
            Some(&member),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(observed.lock().unwrap()[2]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "assistant"
            && m["content"]
                .as_str()
                .is_some_and(|s| s.contains("根据授权资料"))));
    let before = observed.lock().unwrap().len();
    let (status, _) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"继续","conversation_id":conversation}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(observed.lock().unwrap().len(), before);
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"越权读取工程研发"}),
            Some(&member),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["tool_calls"][0]["success"], false);
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"越权读取其他空间","space_id":space}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["tool_calls"][0]["success"], false);
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"联网搜索差旅报销流程的公开补充资料","allow_web":true}),
            Some(&member),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        answer["web_sources"][0]["url"],
        "https://www.postgresql.org/docs/"
    );
    assert_eq!(answer["tool_calls"][0]["name"], "web_search");
    let (_, history) = h
        .request(
            "GET",
            &format!(
                "/api/conversations/{}/messages",
                answer["conversation_id"].as_str().unwrap()
            ),
            Value::Null,
            Some(&member),
            None,
        )
        .await;
    assert_eq!(history[1]["web_sources"], answer["web_sources"]);
    assert_eq!(history[1]["tool_calls"], answer["tool_calls"]);
    assert!(answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["referenced"] == false));
    assert_eq!(answer["web_sources"][0]["referenced"], true);
    let cited = answer["citations"]
        .as_array()
        .unwrap()
        .first()
        .expect("Knowledge dependencies must accompany this mixed-source answer");
    h.state
        .db
        .exec(
            "UPDATE documents SET version=version+1 WHERE id=?",
            vec![cited["document_id"].clone()],
        )
        .await
        .unwrap();
    let (_, redacted) = h
        .request(
            "GET",
            &format!(
                "/api/conversations/{}/messages",
                answer["conversation_id"].as_str().unwrap()
            ),
            Value::Null,
            Some(&member),
            None,
        )
        .await;
    assert!(redacted[1]["content"]
        .as_str()
        .unwrap()
        .contains("不再有访问权限"));
    assert_eq!(redacted[1]["web_sources"], json!([]));
    assert_eq!(redacted[1]["tool_calls"], json!([]));
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"内网网页","allow_web":true}),
            Some(&member),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["tool_calls"][0]["success"], false);
    let mut config = (*h.state.config).clone();
    config.agent_web_enabled = false;
    h.state.config = Arc::new(config);
    h.router = atlas_server::router(h.state.clone());
    let (status, answer) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"联网查找PostgreSQL文档","allow_web":true}),
            Some(&member),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(answer["web_sources"].as_array().unwrap().is_empty());
    let attachment = h.state.db.one("SELECT id FROM documents WHERE space_id=? AND status='ready' AND indexed_version=version LIMIT 1", vec![json!(space)]).await.unwrap().unwrap();
    let (status, scoped) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"差旅报销","document_ids":[attachment["id"]]}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{scoped}");
    assert_eq!(scoped["tool_calls"][0]["success"], true);
    assert!(scoped["citations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["document_id"] == attachment["id"]));
    // Even an admin's tool call cannot escape the attachments selected for this turn.
    let (status, denied) = h
        .request(
            "POST",
            "/api/chat",
            json!({"query":"越权读取其他附件","document_ids":[attachment["id"]]}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{denied}");
    assert_eq!(denied["tool_calls"][0]["success"], false);
    task.abort();
}

#[tokio::test]
async fn media_model_discovery_preserves_secrets_revisions_and_legacy_settings() {
    use axum::{http::HeaderMap, response::IntoResponse};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.login("wang@atlas.local").await;
    let origin = Some("http://localhost:5173");
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let provider = Router::new().route(
        "/v1/models",
        axum::routing::get(move |headers: HeaderMap| {
            let calls = observed.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                if headers.get("authorization").and_then(|v| v.to_str().ok())
                    != Some("Bearer media-fixture-secret")
                {
                    return (
                        StatusCode::UNAUTHORIZED,
                        axum::Json(json!({"error":"media-fixture-secret should never be exposed"})),
                    )
                        .into_response();
                }
                axum::Json(
                    json!({"data":[{"id":"video-test"},{"id":"image-test"},{"id":"image-test"}]}),
                )
                .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let config = model_provider(true, &base, "image-test", "media-fixture-secret");
    let input = json!({"kind":"image","revision":0,"config":config});
    assert_eq!(
        h.request("POST", "/api/models/discover", input.clone(), None, origin)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.request(
            "POST",
            "/api/models/discover",
            input.clone(),
            Some(&member),
            origin
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, list) = h
        .request(
            "POST",
            "/api/models/discover",
            input.clone(),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["models"], json!(["image-test", "video-test"]));
    assert!(!list.to_string().contains("media-fixture-secret"));
    let mut wrong = input.clone();
    wrong["config"]["api_key"] = json!("wrong");
    let (status, failure) = h
        .request("POST", "/api/models/discover", wrong, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!failure.to_string().contains("media-fixture-secret"));
    let mut settings = model_settings(&base, 0);
    settings["image"] = config;
    settings["video"] = model_provider(true, &base, "video-test", "media-fixture-secret");
    let (status, saved) = h
        .request("PUT", "/api/models", settings, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["image"]["has_api_key"], true);
    assert!(!saved.to_string().contains("media-fixture-secret"));
    let (loaded, revision) =
        atlas_server::models::load(&h.state, &h.actor("admin@atlas.local").await.tenant_id)
            .await
            .unwrap();
    assert_eq!(revision, 1);
    assert_eq!(loaded.image.api_key, "media-fixture-secret");
    let rows = h
        .state
        .db
        .rows("SELECT payload FROM tenant_model_configs", vec![])
        .await
        .unwrap();
    assert!(!s(&rows[0], "payload").contains("media-fixture-secret"));
    let reopened = AppState::new((*h.state.config).clone()).await.unwrap();
    assert_eq!(
        atlas_server::models::load(&reopened, &h.actor("admin@atlas.local").await.tenant_id)
            .await
            .unwrap()
            .0
            .video
            .model,
        "video-test"
    );
    let (status, saved) = h
        .request(
            "PUT",
            "/api/models",
            model_settings(&base, 1),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["video"]["model"], "video-test");
    assert_eq!(saved["image"]["has_api_key"], true);
    assert_eq!(
        h.request("POST", "/api/models/discover", input, Some(&admin), origin)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let before = calls.load(Ordering::SeqCst);
    let altered = json!({"kind":"image","revision":2,"config":model_provider(false,"http://127.0.0.1:1/v1","image-test","")});
    assert_eq!(
        h.request(
            "POST",
            "/api/models/discover",
            altered,
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(calls.load(Ordering::SeqCst), before);
    let test =
        json!({"kind":"image","revision":2,"config":model_provider(true,&base,"image-test","")});
    let (status, result) = h
        .request("POST", "/api/models/test", test, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["success"], true);
    assert!(result["message"].as_str().unwrap().contains("生成"));
    task.abort();
}

#[tokio::test]
/// 验证创作策略传入模型、作品与对话请求关联，以及私有媒体和重试幂等。
async fn studio_pi_tools_generate_persisted_media_with_private_assets_and_idempotency() {
    use axum::{http::HeaderMap, response::IntoResponse};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    let mut h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.login("wang@atlas.local").await;
    let origin = Some("http://localhost:5173");
    let image_calls = Arc::new(AtomicUsize::new(0));
    let video_calls = Arc::new(AtomicUsize::new(0));
    let poll_calls = Arc::new(AtomicUsize::new(0));
    let agent_calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let images = image_calls.clone();
    let videos = video_calls.clone();
    let polls = poll_calls.clone();
    let observed = agent_calls.clone();
    let provider=Router::new()
        .route("/v1/chat/completions",axum::routing::post(move |axum::Json(input):axum::Json<Value>| {
            let observed=observed.clone(); async move {
                observed.lock().unwrap().push(input.clone());
                let messages=input["messages"].as_array().unwrap();
                let tool_name=if input["tools"].as_array().unwrap().iter().any(|t|t["function"]["name"]=="generate_image"){"generate_image"}else{"generate_video"};
                let delta=if messages.last().unwrap()["role"]=="tool" {json!({"role":"assistant","content":"已提交异步生成任务，请在作品区查看进度。"})}else{json!({"role":"assistant","tool_calls":[{"index":0,"id":"creative-call","type":"function","function":{"name":tool_name,"arguments":json!({"prompt":"蓝色知识网络，简洁，无文字"}).to_string()}}]})};
                let finish=if delta["tool_calls"].is_array(){"tool_calls"}else{"stop"};
                let body=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"id":"creative","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),json!({"id":"creative","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}]}));
                ([("content-type","text/event-stream")],body)
            }
        }))
        .route("/v1/images/generations",axum::routing::post(move |headers:HeaderMap,axum::Json(input):axum::Json<Value>| {let calls=images.clone();async move{
            assert_eq!(headers["authorization"],"Bearer image-secondary-key");
            assert!(headers.contains_key("idempotency-key"));
            assert_eq!(input["model"],"image-secondary"); assert_eq!(input["size"],"1024x1024");
            calls.fetch_add(1,Ordering::SeqCst);
            axum::Json(json!({"data":[{"b64_json":STANDARD.encode(include_bytes!("../../tests/fixtures/diagram.png"))}]}))
        }}))
        .route("/v1/videos",axum::routing::post(move |headers:HeaderMap,mut form:axum::extract::Multipart| {let calls=videos.clone();async move{
            assert_eq!(headers["authorization"],"Bearer video-secondary-key");assert!(headers.contains_key("idempotency-key"));
            let mut fields=serde_json::Map::new(); while let Some(field)=form.next_field().await.unwrap(){let name=field.name().unwrap().to_owned();fields.insert(name,json!(field.text().await.unwrap()));}
            assert_eq!(fields["model"],"video-secondary");assert_eq!(fields["seconds"],"4");assert_eq!(fields["size"],"1280x720");
            calls.fetch_add(1,Ordering::SeqCst);axum::Json(json!({"id":"video_1","status":"queued"}))
        }}))
        .route("/v1/videos/{id}",axum::routing::get(move ||{let calls=polls.clone();async move{let count=calls.fetch_add(1,Ordering::SeqCst);if count==1 {(StatusCode::SERVICE_UNAVAILABLE,"temporary failure").into_response()} else {axum::Json(json!({"id":"video_1","status":if count==0{"in_progress"}else{"completed"},"progress":50})).into_response()}}}))
        .route("/v1/videos/{id}/content",axum::routing::get(||async{([( "content-type","video/mp4")],include_bytes!("../../tests/fixtures/studio-video.mp4").as_slice()).into_response()}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let cfg = Arc::make_mut(&mut h.state.config);
    cfg.agent_enabled = true;
    cfg.agent_script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("agent-runtime/agent.mjs")
        .display()
        .to_string();
    h.router = atlas_server::router(h.state.clone());
    let mut settings = model_settings(&base, 0);
    settings["embedding"]["enabled"] = json!(false);
    settings["vision"]["enabled"] = json!(false);
    settings["image"] = model_provider(true, &base, "image-test", "media-fixture-secret");
    settings["video"] = model_provider(true, &base, "video-test", "media-fixture-secret");
    assert_eq!(
        h.request("PUT", "/api/models", settings, Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    let image_secondary = id();
    let video_secondary = id();
    let (_, current) = h
        .request("GET", "/api/models", Value::Null, Some(&admin), None)
        .await;
    let mut rows = current["media_models"].as_array().unwrap().clone();
    for row in &mut rows {
        row["config"].as_object_mut().unwrap().remove("has_api_key");
    }
    rows.push(json!({"id":image_secondary,"name":"第二生图服务","kind":"image","config":model_provider(true,&base,"image-secondary","image-secondary-key")}));
    rows.push(json!({"id":video_secondary,"name":"第二视频服务","kind":"video","config":model_provider(true,&base,"video-secondary","video-secondary-key")}));
    let mut update = model_settings(&base, 1);
    update["embedding"]["enabled"] = json!(false);
    update["vision"]["enabled"] = json!(false);
    update.as_object_mut().unwrap().remove("image");
    update.as_object_mut().unwrap().remove("video");
    update["media_models"] = json!(rows);
    update["default_image_id"] = json!("legacy-image");
    update["default_video_id"] = json!("legacy-video");
    let (status, saved) = h
        .request("PUT", "/api/models", update, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (_, caps) = h
        .request(
            "GET",
            "/api/studio/capabilities",
            Value::Null,
            Some(&member),
            None,
        )
        .await;
    assert_eq!(caps["models"].as_array().unwrap().len(), 4);
    assert!(!caps.to_string().contains("secondary-key"));
    assert!(!caps.to_string().contains(&base));
    let (status, created) = h
        .request(
            "POST",
            "/api/studio/projects",
            json!({"title":"蓝色品牌创意"}),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let project_id = created["id"].as_str().unwrap();
    assert_eq!(
        h.request(
            "PUT",
            "/api/personal/preferences",
            json!({"auto_archive":true}),
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut input = json!({"project_id":project_id,"request_id":id(),"prompt":"设计蓝色知识网络海报","kind":"image","image_model_id":image_secondary,"image_size":"1024x1024","video_size":"1280x720","seconds":4});
    assert_eq!(
        h.request(
            "POST",
            "/api/studio/chat",
            input.clone(),
            Some(&member),
            origin
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut invalid = input.clone();
    invalid["image_model_id"] = json!(video_secondary);
    assert_eq!(
        h.request("POST", "/api/studio/chat", invalid, Some(&admin), origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    for _ in 0..2 {
        let (status, result) = h
            .request(
                "POST",
                "/api/studio/chat",
                input.clone(),
                Some(&admin),
                origin,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["engine"], "pi-agent-core");
    }
    let (first, second) = tokio::join!(
        atlas_server::studio::run_one(&h.state),
        atlas_server::studio::run_one(&h.state)
    );
    assert_eq!((first.unwrap() as u8) + (second.unwrap() as u8), 1);
    assert_eq!(image_calls.load(Ordering::SeqCst), 1);
    let (_, view) = h
        .request(
            "GET",
            &format!("/api/studio/projects/{project_id}"),
            Value::Null,
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(view["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(view["jobs"][0]["status"], "completed");
    assert_eq!(view["jobs"][0]["model"], "image-secondary");
    assert_eq!(view["jobs"][0]["request_id"], input["request_id"]);
    assert_eq!(view["messages"][0]["request_id"], input["request_id"]);
    assert_eq!(view["messages"].as_array().unwrap().len(), 2);
    assert_eq!(view["messages"][1]["tool_calls"][0]["success"], true);
    assert!(!view.to_string().contains("media-fixture-secret"));
    let image_id = view["assets"][0]["id"].as_str().unwrap();
    assert_eq!(
        h.request(
            "GET",
            &format!("/api/studio/assets/{image_id}"),
            Value::Null,
            Some(&member),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/studio/assets/{image_id}"))
                .header("cookie", &admin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(
        &response.into_body().collect().await.unwrap().to_bytes()[..],
        include_bytes!("../../tests/fixtures/diagram.png")
    );
    input["kind"] = json!("video");
    input["video_model_id"] = json!(video_secondary);
    input["request_id"] = json!(id());
    input["prompt"] = json!("生成蓝色网络短片");
    let (status, result) = h
        .request("POST", "/api/studio/chat", input, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(atlas_server::studio::run_one(&h.state).await.unwrap());
    let (_, view) = h
        .request(
            "GET",
            &format!("/api/studio/projects/{project_id}"),
            Value::Null,
            Some(&admin),
            None,
        )
        .await;
    let video = view["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|j| j["kind"] == "video")
        .unwrap();
    assert_eq!(video["status"], "running");
    assert_eq!(video["progress"], 50);
    let reopened = AppState::new((*h.state.config).clone()).await.unwrap();
    reopened
        .db
        .exec(
            "UPDATE studio_jobs SET available_at=0 WHERE kind='video'",
            vec![],
        )
        .await
        .unwrap();
    assert!(atlas_server::studio::run_one(&reopened).await.unwrap());
    let retry = reopened
        .db
        .one(
            "SELECT status,poll_errors FROM studio_jobs WHERE kind='video'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&retry, "status"), "running");
    assert_eq!(n(&retry, "poll_errors"), 1);
    reopened
        .db
        .exec(
            "UPDATE studio_jobs SET available_at=0 WHERE kind='video'",
            vec![],
        )
        .await
        .unwrap();
    assert!(atlas_server::studio::run_one(&reopened).await.unwrap());
    assert_eq!(video_calls.load(Ordering::SeqCst), 1);
    let (_, view) = h
        .request(
            "GET",
            &format!("/api/studio/projects/{project_id}"),
            Value::Null,
            Some(&admin),
            None,
        )
        .await;
    let asset = view["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["kind"] == "video")
        .unwrap();
    let path = format!("/api/studio/assets/{}", asset["id"].as_str().unwrap());
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri(&path)
                .header("cookie", &admin)
                .header("range", "bytes=0-31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-type"], "video/mp4");
    assert_eq!(response.headers()["content-length"], "32");
    assert_eq!(
        &response.into_body().collect().await.unwrap().to_bytes()[..],
        &include_bytes!("../../tests/fixtures/studio-video.mp4")[..32]
    );
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri(&path)
                .header("cookie", &admin)
                .header("range", "bytes=999999999-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        h.request("GET", &path, Value::Null, None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.request("GET", &path, Value::Null, Some(&member), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, projects) = h
        .request(
            "GET",
            "/api/studio/projects",
            Value::Null,
            Some(&member),
            None,
        )
        .await;
    assert!(projects.as_array().unwrap().is_empty());
    {
        let calls = agent_calls.lock().unwrap();
        let system = calls[0]["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("默认将用户原始描述直接作为生成提示词"));
        assert!(system.contains("只有用户明确提出优化提示词的需求时才优化"));
        assert!(system.contains("用户闲聊、提问、讨论方案或仅要求优化提示词时，直接回答"));
        assert!(calls[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == "generate_image"));
        assert!(!serde_json::to_string(&*calls)
            .unwrap()
            .contains("media-fixture-secret"));
    }
    let archived=h.state.db.rows("SELECT a.document_id,d.space_id FROM studio_archives a JOIN documents d ON d.id=a.document_id",vec![]).await.unwrap();
    assert_eq!(archived.len(), 2);
    h.index_all().await;
    for row in &archived {
        assert_eq!(
            h.request(
                "GET",
                &format!("/api/documents/{}", s(row, "document_id")),
                Value::Null,
                Some(&member),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    let admin_actor = h.actor("admin@atlas.local").await;
    let found = rag::search(
        &h.state,
        &admin_actor,
        SearchInput {
            query: "蓝色知识网络".into(),
            space_id: Some(s(&archived[0], "space_id").into()),
            limit: Some(10),
            document_ids: None,
            image_base64: None,
            image_mime: None,
        },
    )
    .await
    .unwrap();
    assert!(found.hits.iter().any(|v| v["kind"] == "video"));
    let preserved = AppState::new((*h.state.config).clone()).await.unwrap();
    assert_eq!(
        n(
            &preserved
                .db
                .one(
                    "SELECT auto_archive FROM user_preferences WHERE user_id=?",
                    vec![json!(admin_actor.id)]
                )
                .await
                .unwrap()
                .unwrap(),
            "auto_archive"
        ),
        1
    );
    assert_eq!(
        h.request(
            "PUT",
            "/api/personal/preferences",
            json!({"auto_archive":false}),
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::OK
    );
    let (mut disabled_settings, _) = atlas_server::models::load(&h.state, &admin_actor.tenant_id)
        .await
        .unwrap();
    disabled_settings.image = disabled_settings
        .selected_media("image", Some(&image_secondary))
        .unwrap()
        .unwrap()
        .config
        .clone();
    let disabled_context = atlas_server::studio::Context {
        project_id: project_id.into(),
        request_id: id(),
        kind: "image".into(),
        image_size: "1024x1024".into(),
        video_size: "1280x720".into(),
        seconds: 4,
        settings: disabled_settings,
        operation: "generate".into(),
        quality: "auto".into(),
        style: String::new(),
        image_count: 0,
    };
    atlas_server::studio::queue(
        &h.state,
        &admin_actor,
        &disabled_context,
        "image",
        "关闭自动归档后的作品",
    )
    .await
    .unwrap();
    assert!(atlas_server::studio::run_one(&h.state).await.unwrap());
    assert_eq!(
        h.state
            .db
            .rows("SELECT asset_id FROM studio_archives", vec![])
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        h.state
            .db
            .rows("SELECT id FROM studio_assets", vec![])
            .await
            .unwrap()
            .len(),
        3
    );
    // Archive deletion removes its copy, while the creator's original artwork remains downloadable.
    let doc = s(&archived[0], "document_id");
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/api/documents/{doc}"),
            Value::Null,
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::OK
    );
    while atlas_server::documents::cleanup_one(&h.state)
        .await
        .unwrap()
    {}
    assert_eq!(
        h.request("GET", &path, Value::Null, Some(&admin), None)
            .await
            .0,
        StatusCode::OK
    );
    let actor = h.actor("admin@atlas.local").await;
    h.state
        .db
        .exec(
            "UPDATE users SET active=0 WHERE id=?",
            vec![json!(actor.id)],
        )
        .await
        .unwrap();
    assert_eq!(
        h.request("GET", &path, Value::Null, Some(&admin), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    task.abort();
}

#[tokio::test]
async fn studio_grok_json_video_resumes_and_downloads_proxy_or_native_content() {
    use atlas_server::{
        models::Provider,
        studio::{self, Context},
    };
    use axum::{http::HeaderMap, response::IntoResponse};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    for native in [false, true] {
        let mut h = Harness::new().await;
        let admin = h.login("admin@atlas.local").await;
        let member = h.login("wang@atlas.local").await;
        let actor = h.actor("admin@atlas.local").await;
        let submissions = Arc::new(AtomicUsize::new(0));
        let polls = Arc::new(AtomicUsize::new(0));
        let downloads = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let video_url = format!("{base}/generated.mp4");
        let posts = submissions.clone();
        let reads = polls.clone();
        let proxy_downloads = downloads.clone();
        let native_downloads = downloads.clone();
        let provider = Router::new()
            .route("/v1/videos/generations", axum::routing::post(move |headers: HeaderMap, axum::Json(input): axum::Json<Value>| {
                let posts = posts.clone();
                async move {
                    assert_eq!(headers["content-type"], "application/json");
                    assert_eq!(headers["authorization"], "Bearer grok-fixture-key");
                    assert!(uuid::Uuid::parse_str(headers["idempotency-key"].to_str().unwrap()).is_ok());
                    assert_eq!(input, json!({
                        "model":"grok-imagine-video-1.5-lite", "prompt":"连接知识光点",
                        "duration":if native {12} else {4},
                        "aspect_ratio":if native {"9:16"} else {"16:9"}, "resolution":"720p"
                    }));
                    posts.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({"request_id":"grok_task_1", "id":"wrong_id"}))
                }
            }))
            .route("/v1/videos/{id}", axum::routing::get(move |headers: HeaderMap, axum::extract::Path(key): axum::extract::Path<String>| {
                let reads = reads.clone();
                let video_url = video_url.clone();
                async move {
                    assert_eq!(key, "grok_task_1");
                    assert_eq!(headers["authorization"], "Bearer grok-fixture-key");
                    let count = reads.fetch_add(1, Ordering::SeqCst);
                    axum::Json(if count == 0 {json!({"status":"pending"})} else {json!({"status":"done", "video":{"url":video_url}})})
                }
            }))
            .route("/v1/videos/{id}/content", axum::routing::get(move |headers: HeaderMap, axum::extract::Path(key): axum::extract::Path<String>| {
                let downloads = proxy_downloads.clone();
                async move {
                    assert_eq!(key, "grok_task_1");
                    assert_eq!(headers["authorization"], "Bearer grok-fixture-key");
                    if native {
                        StatusCode::NOT_FOUND.into_response()
                    } else {
                        downloads.fetch_add(1, Ordering::SeqCst);
                        ([("content-type", "video/mp4")], include_bytes!("../../tests/fixtures/studio-video.mp4").as_slice()).into_response()
                    }
                }
            }))
            .route("/generated.mp4", axum::routing::get(move |headers: HeaderMap| {
                let downloads = native_downloads.clone();
                async move {
                    assert!(native);
                    assert!(!headers.contains_key("authorization"));
                    downloads.fetch_add(1, Ordering::SeqCst);
                    ([("content-type", "video/mp4")], include_bytes!("../../tests/fixtures/studio-video.mp4").as_slice())
                }
            }));
        let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
        let (_, project) = h
            .request(
                "POST",
                "/api/studio/projects",
                json!({"title":"Grok 协议验证"}),
                Some(&admin),
                Some("http://localhost:5173"),
            )
            .await;
        let (mut settings, _) = atlas_server::models::load(&h.state, &actor.tenant_id)
            .await
            .unwrap();
        settings.video = Provider {
            enabled: true,
            base_url: format!("{base}/v1"),
            model: "grok-imagine-video-1.5-lite".into(),
            api_key: "grok-fixture-key".into(),
            dimensions: 0,
        };
        let context = Context {
            project_id: project["id"].as_str().unwrap().into(),
            request_id: id(),
            kind: "video".into(),
            image_size: "1024x1024".into(),
            video_size: if native { "720x1280" } else { "1280x720" }.into(),
            seconds: if native { 12 } else { 4 },
            settings,
            operation: "generate".into(),
            quality: "auto".into(),
            style: String::new(),
            image_count: 0,
        };
        let queued = studio::queue(&h.state, &actor, &context, "video", "连接知识光点")
            .await
            .unwrap();
        let key = queued["job"]["id"].as_str().unwrap();
        assert_eq!(
            studio::queue(&h.state, &actor, &context, "video", "重复调用")
                .await
                .unwrap()["job"]["id"],
            key
        );
        assert!(studio::run_one(&h.state).await.unwrap());
        assert_eq!(
            studio::job_status(&h.state, &actor, &context, key)
                .await
                .unwrap()["status"],
            "running"
        );
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        h.state
            .db
            .exec(
                "UPDATE studio_jobs SET available_at=0 WHERE id=?",
                vec![json!(key)],
            )
            .await
            .unwrap();
        h.state = AppState::new((*h.state.config).clone()).await.unwrap();
        h.router = atlas_server::router(h.state.clone());
        assert!(studio::run_one(&h.state).await.unwrap());
        let status = studio::job_status(&h.state, &actor, &context, key)
            .await
            .unwrap();
        assert_eq!(status["status"], "completed");
        assert_eq!(status["progress"], 100);
        assert_eq!(
            studio::queue(&h.state, &actor, &context, "video", "完成后重试")
                .await
                .unwrap()["job"]["id"],
            key
        );
        assert!(!studio::run_one(&h.state).await.unwrap());
        assert_eq!(submissions.load(Ordering::SeqCst), 1);
        assert_eq!(polls.load(Ordering::SeqCst), 2);
        assert_eq!(downloads.load(Ordering::SeqCst), 1);
        let row = h
            .state
            .db
            .one(
                "SELECT id FROM studio_assets WHERE job_id=?",
                vec![json!(key)],
            )
            .await
            .unwrap()
            .unwrap();
        let path = format!("/api/studio/assets/{}", s(&row, "id"));
        let response = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header("cookie", &admin)
                    .header("range", "bytes=0-31")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-type"], "video/mp4");
        assert_eq!(
            &response.into_body().collect().await.unwrap().to_bytes()[..],
            &include_bytes!("../../tests/fixtures/studio-video.mp4")[..32]
        );
        assert_eq!(
            h.request("GET", &path, Value::Null, Some(&member), None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        task.abort();
    }
}

#[tokio::test]
async fn studio_interrupted_paid_submission_is_not_repeated_and_failures_are_redacted() {
    use atlas_server::studio::{self, Context};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let actor = h.actor("admin@atlas.local").await;
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let provider = Router::new().route(
        "/v1/images/generations",
        axum::routing::post(move || {
            let calls = observed.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({"error":"fixture-secret must be redacted"})),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let (_, created) = h
        .request(
            "POST",
            "/api/studio/projects",
            json!({"title":"恢复测试"}),
            Some(&admin),
            Some("http://localhost:5173"),
        )
        .await;
    let (mut settings, _) = atlas_server::models::load(&h.state, &actor.tenant_id)
        .await
        .unwrap();
    settings.image = atlas_server::models::Provider {
        enabled: true,
        base_url: base,
        model: "image-test".into(),
        api_key: "fixture-secret".into(),
        dimensions: 3,
    };
    let context = Context {
        project_id: created["id"].as_str().unwrap().into(),
        request_id: id(),
        kind: "image".into(),
        image_size: "1024x1024".into(),
        video_size: "1280x720".into(),
        seconds: 4,
        settings,
        operation: "generate".into(),
        quality: "auto".into(),
        style: String::new(),
        image_count: 0,
    };
    assert!(
        studio::queue(&h.state, &actor, &context, "video", "invalid mode")
            .await
            .is_err()
    );
    let queued = studio::queue(&h.state, &actor, &context, "image", "安全提示词")
        .await
        .unwrap();
    let job_id = queued["job"]["id"].clone();
    h.state
        .db
        .exec(
            "UPDATE studio_jobs SET status='running',lease_until=0 WHERE id=?",
            vec![job_id.clone()],
        )
        .await
        .unwrap();
    assert!(!studio::run_one(&h.state).await.unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        studio::job_status(&h.state, &actor, &context, job_id.as_str().unwrap())
            .await
            .unwrap()["status"],
        "failed"
    );
    let mut next = context.clone();
    next.request_id = id();
    let job = studio::queue(&h.state, &actor, &next, "image", "安全提示词")
        .await
        .unwrap();
    assert!(studio::run_one(&h.state).await.unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let status = studio::job_status(&h.state, &actor, &next, job["job"]["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(status["status"], "failed");
    assert!(!status.to_string().contains("fixture-secret"));
    assert!(!studio::run_one(&h.state).await.unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn media_catalog_keeps_keys_by_id_supports_defaults_removal_and_legacy_upgrade() {
    use axum::http::HeaderMap;
    use std::sync::{Arc, Mutex};
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let origin = Some("http://localhost:5173");
    let keys = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = keys.clone();
    let provider = Router::new().route(
        "/v1/models",
        axum::routing::get(move |headers: HeaderMap| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(
                    headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .into(),
                );
                axum::Json(json!({"data":[{"id":"image-a"},{"id":"image-b"},{"id":"video-a"}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let a = id();
    let b = id();
    let v = id();
    let rows = json!([
        {"id":a,"name":"生图 A","kind":"image","config":model_provider(true,&base,"image-a","catalog-key-a")},
        {"id":b,"name":"生图 B","kind":"image","config":model_provider(true,&base,"image-b","catalog-key-b")},
        {"id":v,"name":"视频 A","kind":"video","config":model_provider(false,&base,"video-a","catalog-video-key")}
    ]);
    let mut body = model_settings(&base, 0);
    body["media_models"] = rows.clone();
    body["default_image_id"] = json!(b);
    body["default_video_id"] = json!(v);
    let (status, saved) = h
        .request("PUT", "/api/models", body.clone(), Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["image"]["model"], "image-b");
    assert_eq!(saved["media_models"].as_array().unwrap().len(), 3);
    assert!(!saved.to_string().contains("catalog-key"));
    let actor = h.actor("admin@atlas.local").await;
    let reopened = AppState::new((*h.state.config).clone()).await.unwrap();
    let (loaded, _) = atlas_server::models::load(&reopened, &actor.tenant_id)
        .await
        .unwrap();
    assert_eq!(loaded.media()[0].config.api_key, "catalog-key-a");
    assert_eq!(loaded.media()[1].config.api_key, "catalog-key-b");
    assert_eq!(loaded.selected_media("image", None).unwrap().unwrap().id, b);
    let (_, caps) = h
        .request(
            "GET",
            "/api/studio/capabilities",
            Value::Null,
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(caps["models"].as_array().unwrap().len(), 2);
    assert_eq!(caps["video"]["enabled"], false);
    assert_eq!(caps["default_image_id"], b);
    for key in [&a, &b] {
        let input = json!({"kind":"image","config_id":key,"revision":1,"config":model_provider(false,&base,"","")});
        assert_eq!(
            h.request("POST", "/api/models/discover", input, Some(&admin), origin)
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        *keys.lock().unwrap(),
        vec!["Bearer catalog-key-a", "Bearer catalog-key-b"]
    );
    let fresh = id();
    let input = json!({"kind":"image","config_id":fresh,"revision":1,"config":model_provider(false,&base,"","")});
    assert_eq!(
        h.request("POST", "/api/models/discover", input, Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(keys.lock().unwrap().last().unwrap(), "");
    let before = keys.lock().unwrap().len();
    let changed = json!({"kind":"image","config_id":a,"revision":1,"config":model_provider(false,"http://127.0.0.1:1/v1","","")});
    assert_eq!(
        h.request(
            "POST",
            "/api/models/discover",
            changed,
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(keys.lock().unwrap().len(), before);
    let mut edited = rows.clone();
    edited.as_array_mut().unwrap().reverse();
    for row in edited.as_array_mut().unwrap() {
        row["config"].as_object_mut().unwrap().remove("api_key");
    }
    edited[0]["config"]["clear_api_key"] = json!(true); // clear video only
    body["revision"] = json!(1);
    body["media_models"] = edited.clone();
    assert_eq!(
        h.request("PUT", "/api/models", body.clone(), Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    let (loaded, _) = atlas_server::models::load(&h.state, &actor.tenant_id)
        .await
        .unwrap();
    assert!(loaded
        .media()
        .iter()
        .find(|m| m.id == v)
        .unwrap()
        .config
        .api_key
        .is_empty());
    assert_eq!(
        loaded
            .media()
            .iter()
            .find(|m| m.id == a)
            .unwrap()
            .config
            .api_key,
        "catalog-key-a"
    );
    // Older RAG clients omit the catalog; their saves must not delete media profiles.
    let (_, legacy_saved) = h
        .request(
            "PUT",
            "/api/models",
            model_settings(&base, 2),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(legacy_saved["media_models"].as_array().unwrap().len(), 3);
    assert_eq!(legacy_saved["default_image_id"], b);
    let mut duplicate = body.clone();
    duplicate["revision"] = json!(3);
    duplicate["media_models"][1]["id"] = duplicate["media_models"][0]["id"].clone();
    assert_eq!(
        h.request("PUT", "/api/models", duplicate, Some(&admin), origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut mismatched = body.clone();
    mismatched["revision"] = json!(3);
    mismatched["media_models"][1]["kind"] = json!("video");
    assert_eq!(
        h.request("PUT", "/api/models", mismatched, Some(&admin), origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    body["revision"] = json!(3);
    body["media_models"] = json!([]);
    body["default_image_id"] = Value::Null;
    body["default_video_id"] = Value::Null;
    let (status, deleted) = h
        .request("PUT", "/api/models", body, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    let (loaded, _) = atlas_server::models::load(&h.state, &actor.tenant_id)
        .await
        .unwrap();
    assert!(loaded.media().is_empty());
    assert!(!loaded.image.enabled);
    assert!(loaded.selected_media("image", Some(&a)).is_err());
    // Old on-disk encrypted Settings without the new fields still expose the existing provider.
    let legacy = json!({"chat":loaded.chat,"embedding":loaded.embedding,"vision":loaded.vision,"image":{"enabled":true,"base_url":base,"model":"old-image","api_key":"old-key","dimensions":0},"video":loaded.video});
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    let mut plaintext = serde_json::to_vec(&legacy).unwrap();
    let nonce = [3_u8; 12];
    let cipher = LessSafeKey::new(
        UnboundKey::new(
            &AES_256_GCM,
            h.state.model_key.as_ref().unwrap().as_ref().as_ref(),
        )
        .unwrap(),
    );
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(actor.tenant_id.as_bytes()),
            &mut plaintext,
        )
        .unwrap();
    let encrypted = STANDARD.encode([nonce.as_slice(), plaintext.as_slice()].concat());
    h.state
        .db
        .exec(
            "UPDATE tenant_model_configs SET payload=? WHERE tenant_id=?",
            vec![json!(encrypted), json!(actor.tenant_id)],
        )
        .await
        .unwrap();
    let (upgraded, _) = atlas_server::models::load(&h.state, &actor.tenant_id)
        .await
        .unwrap();
    assert_eq!(upgraded.media().len(), 1);
    assert_eq!(upgraded.media()[0].id, "legacy-image");
    assert_eq!(upgraded.image.api_key, "old-key");
    task.abort();
}

#[tokio::test]
async fn short_passwords_and_private_personal_spaces_remain_isolated() {
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.login("wang@atlas.local").await;
    let origin = Some("http://localhost:5173");
    for password in ["1", "ab", "中文"] {
        let(status,result)=h.request("POST","/api/users",json!({"email":format!("{}@short.local",id()),"name":"短密码人员","password":password,"role":"member"}),Some(&admin),origin).await;
        assert_eq!(status, StatusCode::OK, "{result}");
    }
    assert!(atlas_server::auth::validate_password("").is_err());
    assert!(atlas_server::auth::validate_password(&"x".repeat(129)).is_err());
    let (status, pref) = h
        .request(
            "GET",
            "/api/personal/preferences",
            Value::Null,
            Some(&member),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pref["auto_archive"], false);
    let (status, pref) = h
        .request(
            "PUT",
            "/api/personal/preferences",
            json!({"auto_archive":true}),
            Some(&member),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let space = pref["space_id"].as_str().unwrap();
    let (_, doc) = h
        .request(
            "POST",
            "/api/documents",
            json!({"space_id":space,"title":"私有航线","content":"私有航线机密资料"}),
            Some(&member),
            origin,
        )
        .await;
    h.index_all().await;
    let (_, admin_spaces) = h
        .request("GET", "/api/spaces", Value::Null, Some(&admin), None)
        .await;
    assert!(admin_spaces
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["id"] != space));
    assert_eq!(
        h.request(
            "GET",
            &format!("/api/documents/{}", doc["id"].as_str().unwrap()),
            Value::Null,
            Some(&admin),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.request(
            "PUT",
            &format!("/api/spaces/{space}/grants"),
            json!([]),
            Some(&member),
            origin
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, pref) = h
        .request(
            "PUT",
            "/api/personal/preferences",
            json!({"auto_archive":false}),
            Some(&member),
            origin,
        )
        .await;
    assert_eq!(pref["space_id"], space);
}

#[tokio::test]
async fn minio_settings_are_encrypted_hot_applied_and_keep_old_object_locations() {
    if std::env::var("ATLAS_TEST_S3_ENDPOINT").is_err() {
        return;
    }
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.login("wang@atlas.local").await;
    let origin = Some("http://localhost:5173");
    let actor = h.actor("admin@atlas.local").await;
    let legacy = format!("{}/legacy/{}.txt", actor.tenant_id, id());
    h.state.storage.put(&legacy, b"legacy").await.unwrap();
    let input = json!({"enabled":true,"revision":0,"endpoint":std::env::var("ATLAS_TEST_S3_ENDPOINT").unwrap(),"bucket":"atlas-test","access_key":std::env::var("ATLAS_TEST_S3_ACCESS_KEY").unwrap(),"secret_key":std::env::var("ATLAS_TEST_S3_SECRET_KEY").unwrap(),"region":"us-east-1"});
    assert_eq!(
        h.request(
            "PUT",
            "/api/settings/storage",
            input.clone(),
            Some(&member),
            origin
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, probe) = h
        .request(
            "POST",
            "/api/settings/storage/test",
            input.clone(),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    let (status, saved) = h
        .request(
            "PUT",
            "/api/settings/storage",
            input.clone(),
            Some(&admin),
            origin,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["config"]["has_secret"], true);
    assert!(saved["config"].get("secret_key").is_none());
    let key = format!("{}/settings/{}.txt", actor.tenant_id, id());
    h.state.storage.put(&key, b"new s3").await.unwrap();
    let profile = h
        .state
        .db
        .one("SELECT payload FROM storage_profiles", vec![])
        .await
        .unwrap()
        .unwrap();
    assert!(!s(&profile, "payload").contains(&std::env::var("ATLAS_TEST_S3_SECRET_KEY").unwrap()));
    let mut off = input.clone();
    off["enabled"] = json!(false);
    off["revision"] = json!(1);
    off["secret_key"] = Value::Null;
    assert_eq!(
        h.request("PUT", "/api/settings/storage", off, Some(&admin), origin)
            .await
            .0,
        StatusCode::OK
    );
    let local = format!("{}/settings/{}.txt", actor.tenant_id, id());
    h.state.storage.put(&local, b"local").await.unwrap();
    let reopened = AppState::new((*h.state.config).clone()).await.unwrap();
    assert_eq!(reopened.storage.get(&legacy).await.unwrap(), b"legacy");
    assert_eq!(reopened.storage.get(&key).await.unwrap(), b"new s3");
    assert_eq!(reopened.storage.get(&local).await.unwrap(), b"local");
    reopened.storage.delete(&key).await.unwrap();
    assert!(reopened.storage.get(&key).await.is_err());
    assert_eq!(
        h.request("PUT", "/api/settings/storage", input, Some(&admin), origin)
            .await
            .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn qdrant_semantic_recall_deletion_rebuild_and_current_acl_are_real() {
    if std::env::var("ATLAS_TEST_QDRANT_URL").is_err() {
        return;
    }
    let h = Harness::new().await;
    let admin = h.login("admin@atlas.local").await;
    let member = h.actor("wang@atlas.local").await;
    let actor = h.actor("admin@atlas.local").await;
    let origin = Some("http://localhost:5173");
    let provider=Router::new().route("/v1/embeddings",axum::routing::post(|axum::Json(v):axum::Json<Value>|async move {axum::Json(json!({"data":v["input"].as_array().unwrap().iter().enumerate().map(|(i,_)|json!({"index":i,"embedding":[1.0,0.0,0.0]})).collect::<Vec<_>>()}))}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let mut settings = model_settings(&base, 0);
    settings["chat"]["enabled"] = json!(false);
    settings["vision"]["enabled"] = json!(false);
    let (status, result) = h
        .request("PUT", "/api/models", settings, Some(&admin), origin)
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    h.index_all().await;
    let errors = h
        .state
        .db
        .rows(
            "SELECT error FROM vector_jobs WHERE error IS NOT NULL OR synced_revision<revision",
            vec![],
        )
        .await
        .unwrap();
    assert!(errors.is_empty(), "{errors:?}");
    let search = |space: String| SearchInput {
        query: "鲸鱼远航".into(),
        space_id: Some(space),
        limit: Some(10),
        document_ids: None,
        image_base64: None,
        image_mime: None,
    };
    let hr = h.space("人力与行政").await;
    let found = rag::search(&h.state, &actor, search(hr.clone()))
        .await
        .unwrap();
    assert_eq!(found.mode, "hybrid");
    assert!(
        !found.hits.is_empty(),
        "semantic-only recall must come from Qdrant"
    );
    assert!(rag::search(&h.state, &member, search(hr.clone()))
        .await
        .is_err());
    let document = found.hits[0]["document_id"].as_str().unwrap();
    let collection = h
        .state
        .db
        .one("SELECT name FROM vector_collections LIMIT 1", vec![])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/api/documents/{document}"),
            Value::Null,
            Some(&admin),
            origin
        )
        .await
        .0,
        StatusCode::OK
    );
    let found = rag::search(&h.state, &actor, search(hr)).await.unwrap();
    assert!(found.hits.iter().all(|v| v["document_id"] != document));
    while atlas_server::qdrant::run_one(&h.state).await.unwrap() {}
    let url = format!(
        "{}/collections/{}/points/count",
        h.state.config.qdrant_url,
        s(&collection, "name")
    );
    let count:Value=h.state.http.post(&url).json(&json!({"exact":true,"filter":{"must":[{"key":"document_id","match":{"value":document}}]}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(count["result"]["count"], 0);
    let response = h
        .state
        .http
        .delete(format!(
            "{}/collections/{}",
            h.state.config.qdrant_url,
            s(&collection, "name")
        ))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    h.state
        .db
        .exec(
            "INSERT INTO vector_collections(name) VALUES('removed_historical_collection')",
            vec![],
        )
        .await
        .unwrap();
    atlas_server::qdrant::backfill(&h.state).await.unwrap();
    while atlas_server::qdrant::run_one(&h.state).await.unwrap() {}
    let errors = h
        .state
        .db
        .rows(
            "SELECT error FROM vector_jobs WHERE error IS NOT NULL OR synced_revision<revision",
            vec![],
        )
        .await
        .unwrap();
    assert!(errors.is_empty());
    task.abort();
}

#[tokio::test]
async fn bot_tasks_are_private_idempotent_durable_and_support_followups() {
    use atlas_server::bot;
    let h = Harness::new().await;
    h.index_all().await;
    let owner = h.login("admin@atlas.local").await;
    let other = h.login("zhou@atlas.local").await;
    let request_id = id();
    let input = json!({"request_id":request_id,"prompt":"差旅报销","options":{"skill_ids":["research"],"skill_instructions":[{"instructions":"caller-forged"}]}});
    let (status, created) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            input.clone(),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let key = created["id"].as_str().unwrap();
    let (_, again) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            input,
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(again["id"], created["id"]);
    let (status, _) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":request_id,"prompt":"different"}),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let path = format!("/api/bot/tasks/{key}");
    assert_eq!(
        h.bot_request("GET", &path, &other, json!({}), None).await.0,
        StatusCode::NOT_FOUND
    );
    assert!(bot::run_one(&h.state).await.unwrap());
    let (_, detail) = h.bot_request("GET", &path, &owner, json!({}), None).await;
    assert_eq!(detail["task"]["status"], "completed");
    assert!(detail["task"]["result"]
        .as_str()
        .unwrap()
        .contains("原文检索模式"));
    assert!(!detail.to_string().contains("caller-forged"));
    assert_eq!(detail["artifacts"].as_array().unwrap().len(), 1);
    let asset = detail["artifacts"][0]["id"].as_str().unwrap();
    assert_eq!(
        h.bot_request(
            "GET",
            &format!("/api/bot/artifacts/{asset}"),
            &other,
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.bot_request(
            "GET",
            &format!("/api/bot/artifacts/{asset}"),
            &owner,
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, followup) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"请整理关键条目","options":{"parent_task_id":key}}),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{followup}");
    assert!(bot::run_one(&h.state).await.unwrap());
    assert_eq!(
        h.bot_request(
            "POST",
            "/api/bot/tasks",
            &other,
            json!({"request_id":id(),"prompt":"读取他人历史","options":{"parent_task_id":key}}),
            Some("http://localhost:5173")
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (_, cancelled) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"取消测试"}),
            Some("http://localhost:5173"),
        )
        .await;
    let cancel_id = cancelled["id"].as_str().unwrap();
    h.bot_request(
        "POST",
        &format!("/api/bot/tasks/{cancel_id}/cancel"),
        &owner,
        json!({}),
        Some("http://localhost:5173"),
    )
    .await;
    assert!(!bot::run_one(&h.state).await.unwrap());
    assert_eq!(
        h.bot_request(
            "POST",
            &format!("/api/bot/tasks/{cancel_id}/retry"),
            &owner,
            json!({}),
            Some("http://localhost:5173")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(bot::run_one(&h.state).await.unwrap());
}

#[tokio::test]
async fn bot_revoked_evidence_hides_results_downloads_and_followup_context() {
    use atlas_server::bot;
    let h = Harness::new().await;
    h.index_all().await;
    let owner = h.login("admin@atlas.local").await;
    let (_, created) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"差旅报销"}),
            Some("http://localhost:5173"),
        )
        .await;
    let key = created["id"].as_str().unwrap();
    bot::run_one(&h.state).await.unwrap();
    let (_, before) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    let cite = &before["task"]["citations"][0];
    assert!(cite["document_id"].is_string());
    let asset = before["artifacts"][0]["id"].as_str().unwrap();
    let actor = h.actor("admin@atlas.local").await;
    let context = bot::Context {
        task_id: key.into(),
        token: "evidence-checkpoint".into(),
        options: Default::default(),
        connectors: vec![],
    };
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='running',worker_token=?,lease_until=? WHERE id=?",
            vec![json!(context.token), json!(now() + 60000), json!(key)],
        )
        .await
        .unwrap();
    bot::save_runtime(&h.state,&actor,&context,json!({"version":1,"messages":[{"role":"user","content":"private evidence","timestamp":1}]}),before["task"]["citations"].as_array().unwrap(),&[],&Value::Null).await.unwrap();
    assert!(bot::load_runtime(&h.state, &actor, &context)
        .await
        .unwrap()
        .is_some());
    let message = json!({"message_id":id(),"text":"授权资料中的已生成内容","status":"streaming"});
    bot::save_message(&h.state, &actor, &context, &message)
        .await
        .unwrap();
    let mut stream = h.bot_stream(key, &owner).await;
    let (_, snapshot) = next_bot_event(&mut stream).await;
    assert_eq!(snapshot["messages"][0]["content"], message["text"]);
    h.state
        .db
        .exec(
            "UPDATE documents SET version=version+1 WHERE id=?",
            vec![cite["document_id"].clone()],
        )
        .await
        .unwrap();
    assert!(bot::load_runtime(&h.state, &actor, &context).await.is_err());
    assert!(bot::save_message(&h.state, &actor, &context, &message)
        .await
        .is_err());
    assert_eq!(next_bot_event(&mut stream).await.0, "unavailable");
    assert!(
        bot::tool(&h.state, &actor, &context, "runtime_recall", json!({}))
            .await
            .is_err()
    );
    let (_, after) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(after["evidence_available"], false);
    assert!(after["artifacts"].as_array().unwrap().is_empty());
    assert!(after["events"].as_array().unwrap().is_empty());
    assert!(after["messages"].as_array().unwrap().is_empty());
    assert_eq!(
        h.bot_request(
            "GET",
            &format!("/api/bot/artifacts/{asset}"),
            &owner,
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"继续","options":{"parent_task_id":key}}),
            Some("http://localhost:5173")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn bot_connectors_require_exact_approval_keep_secrets_and_deduplicate_writes() {
    use atlas_server::bot::{self, Context, Options};
    use std::sync::{Arc, Mutex};
    let mut h = Harness::new().await;
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let writes = observed.clone();
    let provider = Router::new().route(
        "/tasks",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, axum::Json(input): axum::Json<Value>| {
                let writes = writes.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer connector-test-secret");
                    assert!(headers.contains_key("idempotency-key"));
                    writes.lock().unwrap().push(input);
                    axum::Json(json!({"external_id":"real-fixture-123"}))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    Arc::make_mut(&mut h.state.config).bot_connector_hosts = vec![address.to_string()];
    h.router = atlas_server::router(h.state.clone());
    let owner = h.login("admin@atlas.local").await;
    let other = h.login("zhou@atlas.local").await;
    let actor = h.actor("admin@atlas.local").await;
    assert_eq!(
        h.bot_request(
            "POST",
            "/api/bot/connectors",
            &owner,
            json!({"name":"bad","url":"http://169.254.169.254/","method":"GET"}),
            Some("http://localhost:5173")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status,c)=h.bot_request("POST","/api/bot/connectors",&owner,json!({"name":"项目工具","description":"创建项目条目，input 包含 title","url":format!("http://{address}/tasks"),"method":"POST","token":"connector-test-secret"}),Some("http://localhost:5173")).await;
    assert_eq!(status, StatusCode::OK, "{c}");
    let connector_id = c["id"].as_str().unwrap();
    let (_, list) = h
        .bot_request("GET", "/api/bot/connectors", &owner, json!({}), None)
        .await;
    assert_eq!(list[0]["has_token"], true);
    assert!(!list.to_string().contains("connector-test-secret"));
    let encrypted = h
        .state
        .db
        .one(
            "SELECT encrypted_config FROM bot_connectors WHERE id=?",
            vec![json!(connector_id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!s(&encrypted, "encrypted_config").contains("connector-test-secret"));
    let (_,task)=h.bot_request("POST","/api/bot/tasks",&owner,json!({"request_id":id(),"prompt":"创建项目条目","options":{"connector_ids":[connector_id]}}),Some("http://localhost:5173")).await;
    let key = task["id"].as_str().unwrap();
    h.state.db.exec("UPDATE bot_tasks SET status='running',worker_token='test-token',lease_until=? WHERE id=?",vec![json!(now()+60000),json!(key)]).await.unwrap();
    let context = Context {
        task_id: key.into(),
        token: "test-token".into(),
        options: Options {
            connector_ids: vec![connector_id.into()],
            ..Default::default()
        },
        connectors: vec![],
    };
    let args = json!({"connector_id":connector_id,"input":{"title":"审核好的标题"}});
    let action = bot::tool(&h.state, &actor, &context, "connector_call", args.clone())
        .await
        .unwrap();
    assert_eq!(action["status"], "pending");
    assert!(observed.lock().unwrap().is_empty());
    let duplicate = bot::tool(&h.state, &actor, &context, "connector_call", args.clone())
        .await
        .unwrap();
    assert_eq!(duplicate["action_id"], action["action_id"]);
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='waiting' WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    let action_id = action["action_id"].as_str().unwrap();
    let path = format!("/api/bot/actions/{action_id}/approve");
    assert_eq!(
        h.bot_request(
            "POST",
            &path,
            &other,
            json!({}),
            Some("http://localhost:5173")
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, response) = h
        .bot_request(
            "POST",
            &path,
            &owner,
            json!({}),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["result"]["external_id"], "real-fixture-123");
    assert_ne!(
        h.bot_request(
            "POST",
            &path,
            &owner,
            json!({}),
            Some("http://localhost:5173")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(observed.lock().unwrap().len(), 1);
    assert_eq!(observed.lock().unwrap()[0], args["input"]);
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='running',worker_token='test-token' WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    assert_eq!(
        bot::tool(&h.state, &actor, &context, "connector_call", args)
            .await
            .unwrap()["status"],
        "completed"
    );
    assert_eq!(observed.lock().unwrap().len(), 1);
    let unselected = Context {
        options: Options::default(),
        ..context.clone()
    };
    assert!(bot::tool(
        &h.state,
        &actor,
        &unselected,
        "connector_call",
        json!({"connector_id":connector_id,"input":{}})
    )
    .await
    .is_err());
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='cancelled' WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    assert!(bot::tool(
        &h.state,
        &actor,
        &context,
        "write_artifact",
        json!({"name":"file.txt","content":"no"})
    )
    .await
    .is_err());
    server.abort();
}

#[tokio::test]
async fn bot_initial_evidence_is_opt_in_for_agent_tasks_and_preserves_excerpt_fallback() {
    use atlas_server::bot;
    use std::sync::Arc;

    let mut h = Harness::new().await;
    let actor = h.actor("admin@atlas.local").await;
    let space = h.space("全员知识").await;
    let selected = id();
    let unrelated = id();
    for (document, title, text) in [
        (
            &selected,
            "骑行动画参考",
            "创建一个 HTML，内容是 SVG 绘制鹈鹕骑自行车的 2D 动画。参考主题颜色为海蓝色。",
        ),
        (
            &unrelated,
            "音乐视频背景编辑",
            "生成一个音乐舞蹈视频，使用参考内容替换画面背景。这里不包含骑行实现。",
        ),
    ] {
        h.state.db.exec("INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,version,indexed_version,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'text/plain','fixture',1,'fixture',1,1,'ready',?,?,?)", vec![json!(document),json!(actor.tenant_id),json!(space),json!(title),json!(format!("{title}.txt")),json!(actor.id),json!(now()),json!(now())]).await.unwrap();
        h.state.db.exec("INSERT INTO chunks(id,tenant_id,space_id,document_id,version,text,search_tokens,page,kind,position) VALUES(?,?,?,?,1,?,?,1,'text',0)",vec![json!(id()),json!(actor.tenant_id),json!(space),json!(document),json!(text),json!(rag::tokens(&format!("{title} {text}")).join(" "))]).await.unwrap();
    }
    let prompt = "帮我创建一个 HTML，内容是 SVG 绘制鹈鹕骑自行车的 2D 动画，不使用任何 skill";
    let recalled = rag::search(
        &h.state,
        &actor,
        SearchInput {
            query: prompt.into(),
            space_id: None,
            document_ids: None,
            limit: Some(8),
            image_base64: None,
            image_mime: None,
        },
    )
    .await
    .unwrap();
    assert!(
        recalled
            .hits
            .iter()
            .any(|hit| hit["document_id"] == unrelated),
        "The fixture must reproduce incidental full-library matches"
    );

    // Exercise the Rust/Node protocol without provider calls or runtime npm
    // dependencies. Capture the actual evidence supplied to model execution.
    let capture = h._temporary.path().join("agent-input.jsonl");
    let script = h._temporary.path().join("agent-fixture.mjs");
    std::fs::write(&script, format!(r#"import {{ appendFileSync }} from 'node:fs';
import {{ createInterface }} from 'node:readline';
const input = createInterface({{ input: process.stdin }});
input.once('line', (line) => {{
  appendFileSync({}, line + '\n');
  process.stdout.write(JSON.stringify({{ type: 'result', answer: '已创建 SVG 骑行动画。' }}) + '\n', () => process.exit(0));
}});
"#, serde_json::to_string(&capture.to_string_lossy()).unwrap())).unwrap();
    let config = Arc::make_mut(&mut h.state.config);
    config.agent_enabled = true;
    config.ai_api_key = "fixture-no-provider-call".into();
    config.chat_model = "fixture-agent".into();
    config.chat_base_url.clear();
    config.agent_script = script.to_string_lossy().into();
    h.router = atlas_server::router(h.state.clone());
    let owner = h.login("admin@atlas.local").await;

    let mut task_ids = Vec::new();
    for document_ids in [json!([]), json!([selected])] {
        let (status, created) = h
            .bot_request(
                "POST",
                "/api/bot/tasks",
                &owner,
                json!({"request_id":id(),"prompt":prompt,"options":{"document_ids":document_ids}}),
                Some("http://localhost:5173"),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert!(bot::run_one(&h.state).await.unwrap());
        let key = created["id"].as_str().unwrap();
        let (_, detail) = h
            .bot_request(
                "GET",
                &format!("/api/bot/tasks/{key}"),
                &owner,
                json!({}),
                None,
            )
            .await;
        assert_eq!(detail["task"]["status"], "completed", "{detail}");
        let citations = detail["task"]["citations"].as_array().unwrap();
        if task_ids.is_empty() {
            assert!(
                citations.is_empty(),
                "A standalone creation task must not acquire unrelated knowledge dependencies"
            );
        } else {
            assert!(
                !citations.is_empty(),
                "Explicit reference documents must still seed evidence"
            );
            assert!(citations.iter().all(|hit| hit["document_id"] == selected));
        }
        task_ids.push(key.to_owned());
    }
    let inputs: Vec<Value> = std::fs::read_to_string(&capture)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(inputs.len(), 2);
    let first_history = inputs[0]["history"].to_string();
    assert!(!first_history.contains("音乐视频背景编辑"));
    assert!(!first_history.contains("骑行动画参考"));
    let attachment_history = inputs[1]["history"].to_string();
    assert!(attachment_history.contains("骑行动画参考"));
    assert!(!attachment_history.contains("音乐视频背景编辑"));

    // Both ways of reaching original-excerpt mode retain automatic retrieval.
    for agent_enabled in [false, true] {
        let config = Arc::make_mut(&mut h.state.config);
        config.agent_enabled = agent_enabled;
        config.chat_model.clear();
        h.router = atlas_server::router(h.state.clone());
        let (status, created) = h
            .bot_request(
                "POST",
                "/api/bot/tasks",
                &owner,
                json!({"request_id":id(),"prompt":prompt}),
                Some("http://localhost:5173"),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert!(bot::run_one(&h.state).await.unwrap());
        let (_, detail) = h
            .bot_request(
                "GET",
                &format!("/api/bot/tasks/{}", created["id"].as_str().unwrap()),
                &owner,
                json!({}),
                None,
            )
            .await;
        assert_eq!(detail["task"]["status"], "completed", "{detail}");
        assert!(detail["task"]["result"]
            .as_str()
            .unwrap()
            .contains("原文检索模式"));
        assert!(detail["task"]["citations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hit| hit["document_id"] == unrelated));
    }
    assert_eq!(
        std::fs::read_to_string(&capture).unwrap().lines().count(),
        2,
        "Excerpt fallback must not invoke the model"
    );

    // The fixture answer has no inline citations. Evidence actually supplied
    // to execution must still fence access after its document version changes.
    h.state
        .db
        .exec(
            "UPDATE documents SET version=version+1 WHERE id=?",
            vec![json!(selected)],
        )
        .await
        .unwrap();
    for (index, key) in task_ids.iter().enumerate() {
        let (_, detail) = h
            .bot_request(
                "GET",
                &format!("/api/bot/tasks/{key}"),
                &owner,
                json!({}),
                None,
            )
            .await;
        assert_eq!(detail["evidence_available"], index == 0);
    }
}

#[tokio::test]
async fn bot_pi_executes_plans_and_saves_real_artifacts_with_authorized_tool_catalog() {
    use axum::response::IntoResponse;
    use std::sync::{Arc, Mutex};
    let mut h = Harness::new().await;
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = calls.clone();
    let provider=Router::new().route("/v1/chat/completions",axum::routing::post(move |axum::Json(input):axum::Json<Value>|{
        let calls=observed.clone();async move {
            let mut requests=calls.lock().unwrap();let count=requests.len();requests.push(input);
            let tool=match count {0=>Some(("task_plan",json!({"steps":[{"title":"整理资料","status":"running"},{"title":"保存报告","status":"pending"}]}))),1=>Some(("write_artifact",json!({"name":"report.md","content":"# Real deliverable\nCreated through Pi tool execution."}))),2..=21=>Some(("read_artifact",json!({"artifact_id":requests.last().unwrap()["messages"].as_array().unwrap().iter().find_map(|m|m["content"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()).and_then(|v|v["artifact_id"].as_str().map(str::to_owned))).unwrap(),"start":count-2,"limit":1}))),22=>Some(("task_plan",json!({"steps":[{"title":"整理资料","status":"completed"},{"title":"保存报告","status":"completed"}]}))),_=>None};
            let delta=if let Some((name,args))=tool{json!({"role":"assistant","tool_calls":[{"index":0,"id":format!("call-{count}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]})}else{json!({"role":"assistant","content":"报告已保存，请在成果文件中下载。"})};
            let finish=if delta["tool_calls"].is_array(){"tool_calls"}else{"stop"};
            let body=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),json!({"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}]}));
            ([("content-type","text/event-stream")],body).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let config = Arc::make_mut(&mut h.state.config);
    config.agent_enabled = true;
    config.ai_base_url = format!("http://{address}/v1");
    config.ai_api_key = "test-model-key".into();
    config.chat_model = "fixture-agent".into();
    config.agent_script = root
        .join("agent-runtime/agent.mjs")
        .to_string_lossy()
        .into();
    h.router = atlas_server::router(h.state.clone());
    let owner = h.login("admin@atlas.local").await;
    let (_, task) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"整理一份报告","options":{"skill_ids":["writing"]}}),
            Some("http://localhost:5173"),
        )
        .await;
    if h.state.db.postgres {
        // Deterministically overlap the first checkpoint row lock with renewal.
        h.state.db.exec("CREATE FUNCTION delay_first_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS (SELECT task_id FROM bot_runtime WHERE task_id=NEW.task_id) THEN PERFORM pg_sleep(2.2); END IF; RETURN NEW; END $$", vec![]).await.unwrap();
        h.state.db.exec("CREATE TRIGGER checkpoint_delay BEFORE INSERT ON bot_runtime FOR EACH ROW EXECUTE FUNCTION delay_first_checkpoint()", vec![]).await.unwrap();
    }
    assert!(atlas_server::bot::run_one(&h.state).await.unwrap());
    let key = task["id"].as_str().unwrap();
    let (_, detail) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(detail["task"]["status"], "completed", "{detail}");
    assert_eq!(detail["artifacts"][0]["name"], "report.md");
    assert_eq!(detail["task"]["plan"][1]["status"], "completed");
    let asset = h
        .state
        .db
        .one(
            "SELECT storage_key FROM bot_artifacts WHERE task_id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        h.state.storage.get(s(&asset, "storage_key")).await.unwrap(),
        b"# Real deliverable\nCreated through Pi tool execution."
    );
    {
        let observed = calls.lock().unwrap();
        assert_eq!(observed.len(), 24);
        let names = observed[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(names.contains(&"task_plan"));
        assert!(names.contains(&"write_artifact"));
        assert!(!names.contains(&"connector_call"));
        assert!(!names.contains(&"run_python"));
        assert!(!names.contains(&"web_search"));
        assert!(observed[2]["messages"].to_string().contains("report.md"));
    }
    // Simulate a crash AFTER an artifact was saved but BEFORE its tool-result checkpoint.
    let (_, interrupted) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"继续保存报告"}),
            Some("http://localhost:5173"),
        )
        .await;
    let second_id = interrupted["id"].as_str().unwrap();
    h.state.db.exec("UPDATE bot_tasks SET status='running',worker_token='crash-token',lease_until=? WHERE id=?",vec![json!(now()-1000),json!(second_id)]).await.unwrap();
    let actor = h.actor("admin@atlas.local").await;
    let context = atlas_server::bot::Context {
        task_id: second_id.into(),
        token: "crash-token".into(),
        options: Default::default(),
        connectors: vec![],
    };
    let args = json!({"name":"recovered.md","content":"committed before crash"});
    let runtime = json!({"version":1,"messages":[{"role":"user","content":"继续保存报告","timestamp":1},{"role":"assistant","content":[{"type":"toolCall","id":"saved-artifact-call","name":"write_artifact","arguments":args}],"api":"openai-completions","provider":"atlas","model":"fixture-agent","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1}]});
    atlas_server::bot::save_runtime(&h.state, &actor, &context, runtime, &[], &[], &Value::Null)
        .await
        .unwrap();
    assert!(atlas_server::bot::begin_call(
        &h.state,
        &actor,
        &context,
        "saved-artifact-call",
        "write_artifact",
        &args
    )
    .await
    .unwrap()
    .is_none());
    let file = atlas_server::bot::tool(&h.state, &actor, &context, "write_artifact", args)
        .await
        .unwrap();
    atlas_server::bot::finish_call(
        &h.state,
        &actor,
        &context,
        "saved-artifact-call",
        &json!({"ok":true,"data":file}),
    )
    .await
    .unwrap();
    let before = h
        .state
        .db
        .one(
            "SELECT storage_key FROM bot_artifacts WHERE task_id=?",
            vec![json!(second_id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(atlas_server::bot::run_one(&h.state).await.unwrap());
    let (_, recovered) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{second_id}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(recovered["task"]["status"], "completed", "{recovered}");
    assert!(recovered["events"].to_string().contains("从检查点恢复"));
    let after = h
        .state
        .db
        .one(
            "SELECT storage_key FROM bot_artifacts WHERE task_id=?",
            vec![json!(second_id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before, after, "committed artifact was replayed");
    assert_eq!(recovered["artifacts"].as_array().unwrap().len(), 1);
    let requests = calls.lock().unwrap();
    assert!(requests.last().unwrap()["messages"]
        .to_string()
        .contains("saved-artifact-call"));
    assert!(!requests
        .last()
        .unwrap()
        .to_string()
        .contains("test-model-key"));
    server.abort();
}

#[tokio::test]
async fn bot_python_container_runs_calculations_and_has_no_network_or_host_secrets() {
    if std::env::var("ATLAS_TEST_BOT_CODE").as_deref() != Ok("true") {
        return;
    }
    let h = Harness::new().await;
    let result=atlas_server::bot::run_python(&h.state,"import os, socket\nprint(sum([10,20,30]))\nprint(os.path.exists('/app/data'))\nprint(bool(os.getenv('AI_API_KEY')))\ntry:\n s=socket.create_connection(('1.1.1.1',443),timeout=1)\n print('NETWORK')\nexcept OSError:\n print('ISOLATED')\n").await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(result["stdout"], "60\nFalse\nFalse\nISOLATED\n");
}

impl Harness {
    async fn bot_request(
        &self,
        method: &str,
        path: &str,
        credential: &str,
        body: Value,
        origin: Option<&str>,
    ) -> (StatusCode, Value) {
        self.request(method, path, body, Some(credential), origin)
            .await
    }

    async fn bot_stream(&self, key: &str, credential: &str) -> Body {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/bot/tasks/{key}/stream"))
                    .header("cookie", credential)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(response.headers()["x-accel-buffering"], "no");
        response.into_body()
    }
}

async fn next_bot_event(body: &mut Body) -> (String, Value) {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let text = String::from_utf8(frame.to_vec()).unwrap();
    let event = text
        .lines()
        .find_map(|line| line.strip_prefix("event: "))
        .unwrap()
        .to_owned();
    let data = text
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    (event, serde_json::from_str(data).unwrap())
}

#[tokio::test]
async fn bot_public_output_streams_deltas_restores_and_rejects_late_writes() {
    use atlas_server::bot;
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let other = h.login("zhou@atlas.local").await;
    let actor = h.actor("admin@atlas.local").await;
    let (_, created) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"逐步生成报告"}),
            Some("http://localhost:5173"),
        )
        .await;
    let key = created["id"].as_str().unwrap();
    let context = bot::Context {
        task_id: key.into(),
        token: "stream-lease".into(),
        options: Default::default(),
        connectors: vec![],
    };
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='running',worker_token=?,lease_until=? WHERE id=?",
            vec![json!(context.token), json!(now() + 60000), json!(key)],
        )
        .await
        .unwrap();
    assert_eq!(
        h.bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}/stream"),
            &other,
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut stream = h.bot_stream(key, &owner).await;
    let (kind, initial) = next_bot_event(&mut stream).await;
    assert_eq!(kind, "snapshot");
    assert_eq!(initial["task"]["status"], "running");
    assert_eq!(initial["messages"], json!([]));
    let message_id = id();
    let mut message = json!({"message_id":message_id,"text":"第一段","status":"streaming"});
    bot::save_message(&h.state, &actor, &context, &message)
        .await
        .unwrap();
    let (kind, first) = next_bot_event(&mut stream).await;
    assert_eq!(kind, "output");
    assert_eq!(first["text"], "第一段");
    assert_eq!(first["replace"], true);
    message["text"] = json!("第一段，第二段");
    bot::save_message(&h.state, &actor, &context, &message)
        .await
        .unwrap();
    let (_, second) = next_bot_event(&mut stream).await;
    assert_eq!(second["text"], "，第二段");
    assert_eq!(second["replace"], false);
    drop(stream);
    let (_, restored) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(restored["messages"][0]["content"], "第一段，第二段");
    let mut stream = h.bot_stream(key, &owner).await;
    let (_, snapshot) = next_bot_event(&mut stream).await;
    assert_eq!(snapshot["messages"][0]["content"], "第一段，第二段");
    message["status"] = json!("completed");
    bot::save_message(&h.state, &actor, &context, &message)
        .await
        .unwrap();
    let (_, status) = next_bot_event(&mut stream).await;
    assert_eq!(status["text"], "");
    assert_eq!(status["status"], "completed");
    h.bot_request(
        "POST",
        &format!("/api/bot/tasks/{key}/cancel"),
        &owner,
        json!({}),
        Some("http://localhost:5173"),
    )
    .await;
    message["text"] = json!("取消之后不应写入");
    assert!(bot::save_message(&h.state, &actor, &context, &message)
        .await
        .is_err());
    let (kind, stopped) = next_bot_event(&mut stream).await;
    assert_eq!(kind, "snapshot");
    assert_eq!(stopped["task"]["status"], "cancelled");
    assert_eq!(stopped["messages"][0]["content"], "第一段，第二段");
    assert_eq!(next_bot_event(&mut stream).await.0, "end");
}

#[tokio::test]
async fn bot_followup_can_read_previous_files_but_not_unrelated_private_workspaces() {
    use atlas_server::bot::{self, Context, Options};
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let actor = h.actor("admin@atlas.local").await;
    let (_, first) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"第一轮任务"}),
            Some("http://localhost:5173"),
        )
        .await;
    bot::run_one(&h.state).await.unwrap();
    let first_id = first["id"].as_str().unwrap();
    let first_file = h
        .state
        .db
        .one(
            "SELECT id FROM bot_artifacts WHERE task_id=?",
            vec![json!(first_id)],
        )
        .await
        .unwrap()
        .unwrap();
    let (_,second)=h.bot_request("POST","/api/bot/tasks",&owner,json!({"request_id":id(),"prompt":"修改之前的报告","options":{"parent_task_id":first_id}}),Some("http://localhost:5173")).await;
    let second_id = second["id"].as_str().unwrap();
    h.state.db.exec("UPDATE bot_tasks SET status='running',worker_token='file-test',lease_until=? WHERE id=?",vec![json!(now()+60000),json!(second_id)]).await.unwrap();
    let context = Context {
        task_id: second_id.into(),
        token: "file-test".into(),
        options: Options {
            parent_task_id: Some(first_id.into()),
            ..Default::default()
        },
        connectors: vec![],
    };
    let read = bot::tool(
        &h.state,
        &actor,
        &context,
        "read_artifact",
        json!({"artifact_id":s(&first_file,"id"),"limit":20}),
    )
    .await
    .unwrap();
    assert_eq!(read["content"].as_str().unwrap().chars().count(), 20);
    assert_eq!(read["next_start"], 20);
    let (_, unrelated) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"无关任务"}),
            Some("http://localhost:5173"),
        )
        .await;
    let unrelated_id = unrelated["id"].as_str().unwrap();
    bot::run_one(&h.state).await.unwrap();
    let unrelated_file = h
        .state
        .db
        .one(
            "SELECT id FROM bot_artifacts WHERE task_id=?",
            vec![json!(unrelated_id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(bot::tool(
        &h.state,
        &actor,
        &context,
        "read_artifact",
        json!({"artifact_id":s(&unrelated_file,"id")})
    )
    .await
    .is_err());
}

#[tokio::test]
async fn bot_concurrent_admission_preserves_quota_and_rejects_conflicting_request_ids() {
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let request_id = id();
    let (first, second) = tokio::join!(
        h.bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":request_id,"prompt":"内容一"}),
            Some("http://localhost:5173")
        ),
        h.bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":request_id,"prompt":"内容二"}),
            Some("http://localhost:5173")
        ),
    );
    assert!(
        matches!(
            (first.0, second.0),
            (StatusCode::OK, StatusCode::BAD_REQUEST) | (StatusCode::BAD_REQUEST, StatusCode::OK)
        ),
        "{first:?} {second:?}"
    );
    let mut pending = Vec::new();
    for _ in 0..15 {
        let router = h.router.clone();
        let credential = owner.clone();
        pending.push(tokio::spawn(async move {
            router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/bot/tasks")
                        .header("content-type", "application/json")
                        .header("cookie", credential)
                        .header("origin", "http://localhost:5173")
                        .body(Body::from(
                            json!({"request_id":id(),"prompt":"并发任务"}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
                .status()
        }));
    }
    for task in pending {
        let status = task.await.unwrap();
        assert!(
            matches!(status, StatusCode::OK | StatusCode::TOO_MANY_REQUESTS),
            "{status}"
        );
    }
    let actor = h.actor("admin@atlas.local").await;
    let count = h
        .state
        .db
        .one(
            "SELECT COUNT(*) AS total FROM bot_tasks WHERE user_id=?",
            vec![json!(actor.id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n(&count, "total"), 10);
}

#[tokio::test]
async fn bot_checkpoints_and_tool_journal_enforce_owner_encryption_and_cancellation() {
    use atlas_server::bot;
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let actor = h.actor("admin@atlas.local").await;
    let (_, task) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"checkpoint task"}),
            Some("http://localhost:5173"),
        )
        .await;
    let key = task["id"].as_str().unwrap();
    let context = bot::Context {
        task_id: key.into(),
        token: "lease".into(),
        options: Default::default(),
        connectors: vec![],
    };
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='running',worker_token='lease',lease_until=? WHERE id=?",
            vec![json!(now() + 60000), json!(key)],
        )
        .await
        .unwrap();
    bot::save_runtime(&h.state,&actor,&context,json!({"version":1,"messages":[{"role":"user","content":"private-checkpoint-marker","timestamp":1}]}),&[],&[],&Value::Null).await.unwrap();
    let saved = h
        .state
        .db
        .one(
            "SELECT encrypted_state FROM bot_runtime WHERE task_id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!s(&saved, "encrypted_state").contains("private-checkpoint-marker"));
    assert_eq!(
        bot::load_runtime(&h.state, &actor, &context)
            .await
            .unwrap()
            .unwrap()["runtime"]["messages"][0]["content"],
        "private-checkpoint-marker"
    );
    let other = h.actor("wang@atlas.local").await;
    assert!(bot::load_runtime(&h.state, &other, &context).await.is_err());
    let args = json!({"name":"x.md","content":"data"});
    assert!(bot::begin_call(
        &h.state,
        &actor,
        &context,
        "call-1",
        "write_artifact",
        &args
    )
    .await
    .unwrap()
    .is_none());
    // An interrupted call is never automatically executed again.
    assert_eq!(
        bot::begin_call(
            &h.state,
            &actor,
            &context,
            "call-1",
            "write_artifact",
            &args
        )
        .await
        .unwrap()
        .unwrap()["ok"],
        false
    );
    assert!(bot::begin_call(
        &h.state,
        &actor,
        &context,
        "call-1",
        "write_artifact",
        &json!({"content":"different"})
    )
    .await
    .is_err());
    bot::finish_call(
        &h.state,
        &actor,
        &context,
        "call-1",
        &json!({"ok":true,"data":{"artifact_id":"persisted"}}),
    )
    .await
    .unwrap();
    assert_eq!(
        bot::begin_call(
            &h.state,
            &actor,
            &context,
            "call-1",
            "write_artifact",
            &args
        )
        .await
        .unwrap()
        .unwrap()["data"]["artifact_id"],
        "persisted"
    );
    let notes = json!({"findings":[{"fact":"private-factual-marker","refs":["[1]"],"verified":true}],"open_questions":["尚未核实性能数字"],"next_action":"比较观点"});
    let receipt = bot::tool(&h.state, &actor, &context, "task_memory", notes.clone())
        .await
        .unwrap();
    assert!(bot::tool(&h.state,&actor,&context,"task_memory",json!({"findings":[{"fact":"x","refs":[],"verified":"true"}],"open_questions":[],"next_action":""})).await.is_err());
    bot::begin_call(&h.state, &actor, &context, "notes-1", "task_memory", &notes)
        .await
        .unwrap();
    bot::finish_call(
        &h.state,
        &actor,
        &context,
        "notes-1",
        &json!({"ok":true,"data":receipt}),
    )
    .await
    .unwrap();
    let archive = bot::read_history(&h.state, &actor, &context).await.unwrap();
    assert_eq!(archive.len(), 1);
    assert_eq!(
        archive[0]["data"]["findings"][0]["fact"],
        "private-factual-marker"
    );
    assert!(bot::read_history(&h.state, &other, &context).await.is_err());
    let encrypted = h
        .state
        .db
        .one(
            "SELECT encrypted_result FROM bot_tool_calls WHERE task_id=? AND call_id='notes-1'",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!s(&encrypted, "encrypted_result").contains("private-factual-marker"));
    let (_, detail) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert!(!detail.to_string().contains("private-checkpoint-marker"));
    h.bot_request(
        "POST",
        &format!("/api/bot/tasks/{key}/cancel"),
        &owner,
        json!({}),
        Some("http://localhost:5173"),
    )
    .await;
    assert!(bot::read_history(&h.state, &actor, &context).await.is_err());
    assert!(bot::load_runtime(&h.state, &actor, &context).await.is_err());
    assert!(
        bot::finish_call(&h.state, &actor, &context, "call-1", &json!({"ok":true}))
            .await
            .is_err()
    );
}

impl Harness {
    async fn pair_local(&self, owner: &str) -> (String, String) {
        let (status, pairing) = self
            .bot_request(
                "POST",
                "/api/bot/pairings",
                owner,
                json!({}),
                Some("http://localhost:5173"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let token = format!("zd_{}", atlas_server::auth::token());
        let input = json!({"code":pairing["code"],"token":token,"name":"测试电脑","workspace_id":"test-workspace","workspace_title":"测试工作区"});
        let (status, receipt) = self
            .request("POST", "/api/bot/local/pair", input.clone(), None, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{receipt}");
        let (_, repeat) = self
            .request("POST", "/api/bot/local/pair", input, None, None)
            .await;
        assert_eq!(
            receipt, repeat,
            "Lost pairing receipts must be recoverable with the same credential"
        );
        (receipt["id"].as_str().unwrap().to_owned(), token)
    }
}
#[tokio::test]
async fn bot_local_routes_are_private_and_cloud_worker_never_claims_or_recovers_them() {
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let other = h.login("zhou@atlas.local").await;
    let (device, token) = h.pair_local(&owner).await;
    let (_, list) = h
        .bot_request("GET", "/api/bot/devices", &other, json!({}), None)
        .await;
    assert_eq!(list, json!([]));
    let create =
        json!({"request_id":id(),"prompt":"在桌面端执行任务","options":{"local_device_id":device}});
    let (status, _) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &other,
            create.clone(),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, receipt) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            create.clone(),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let key = receipt["id"].as_str().unwrap();
    let (_, repeat) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            create,
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(receipt, repeat);
    assert!(!atlas_server::bot::run_one(&h.state).await.unwrap());
    let (_, poll) = h
        .bot_request("POST", "/api/bot/local/poll", &token, json!({}), None)
        .await;
    assert_eq!(poll["commands"][0]["id"], key);
    let (status, _) = h
        .bot_request("GET", "/api/bot/tasks", &token, json!({}), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = h
        .bot_request(
            "POST",
            &format!("/api/bot/local/tasks/{key}/start"),
            &token,
            json!({"session_id":"session-native"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let waiting = json!({"seq":1,"turn_key":"turn:1","status":"waiting","result":""});
    let (status, _) = h
        .bot_request(
            "POST",
            &format!("/api/bot/local/tasks/{key}/sync"),
            &token,
            waiting,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!atlas_server::bot::run_one(&h.state).await.unwrap());
    let (status, _) = h
        .bot_request(
            "POST",
            &format!("/api/bot/local/tasks/{key}/start"),
            &token,
            json!({"session_id":"session-native"}),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "Harness must resume the task after native approval without retrying execution"
    );
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET lease_until=1 WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    assert!(!atlas_server::bot::run_one(&h.state).await.unwrap());
    let row = h
        .state
        .db
        .one(
            "SELECT status,attempt FROM bot_tasks WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "running");
    assert_eq!(n(&row, "attempt"), 1);
    let (status, _) = h
        .bot_request(
            "POST",
            "/api/bot/local/tasks/unassigned/start",
            &token,
            json!({"session_id":"session-native"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    h.bot_request(
        "POST",
        &format!("/api/bot/tasks/{key}/cancel"),
        &owner,
        json!({}),
        Some("http://localhost:5173"),
    )
    .await;
    let (_, poll) = h
        .bot_request("POST", "/api/bot/local/poll", &token, json!({}), None)
        .await;
    assert_eq!(poll["commands"][0]["status"], "cancelled");
    let (status, _) = h
        .bot_request(
            "POST",
            &format!("/api/bot/local/tasks/{key}/cancel-ack"),
            &token,
            json!({}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, poll) = h
        .bot_request("POST", "/api/bot/local/poll", &token, json!({}), None)
        .await;
    assert_eq!(poll["commands"], json!([]));
}
#[tokio::test]
async fn bot_local_replays_are_idempotent_and_revocation_fences_late_results() {
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let (device, token) = h.pair_local(&owner).await;
    let input = json!({"session_id":"desktop-session","turn_key":"turn:1","request_id":id(),"prompt":"本地发起的任务","title":"本地任务"});
    let (status, receipt) = h
        .bot_request("POST", "/api/bot/local/import", &token, input.clone(), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    let key = receipt["id"].as_str().unwrap();
    let (_, repeat) = h
        .bot_request("POST", "/api/bot/local/import", &token, input, None)
        .await;
    assert_eq!(receipt, repeat);
    let sync = json!({"seq":1,"turn_key":"turn:1","status":"running","result":"","messages":[{"id":id(),"content":"公开输出","status":"streaming","created_at":now()}],"events":[{"id":id(),"name":"bash","success":true,"created_at":now()}]});
    let path = format!("/api/bot/local/tasks/{key}/sync");
    for _ in 0..2 {
        let (status, v) = h
            .bot_request("POST", &path, &token, sync.clone(), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{v}");
    }
    let mut changed = sync.clone();
    changed["result"] = json!("冲突内容");
    let (status, _) = h.bot_request("POST", &path, &token, changed, None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, detail) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(detail["messages"].as_array().unwrap().len(), 1);
    assert_eq!(detail["events"].as_array().unwrap().len(), 1);
    let artifact =
        json!({"name":"write_artifact","args":{"name":"本地成果.md","content":"# 本地真实成果"}});
    let (status, output) = h
        .bot_request(
            "POST",
            &format!("/api/bot/local/tasks/{key}/tool"),
            &token,
            artifact,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{output}");
    let (status, _) = h
        .bot_request(
            "DELETE",
            &format!("/api/bot/devices/{device}"),
            &owner,
            json!({}),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut late = sync;
    late["seq"] = json!(2);
    late["status"] = json!("completed");
    late["result"] = json!("迟到的结果");
    let (status, _) = h.bot_request("POST", &path, &token, late, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (_, detail) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(detail["task"]["status"], "cancelled");
    assert_eq!(detail["task"]["result"], "");
    assert_eq!(detail["artifacts"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn bot_local_completion_restores_followup_affinity_and_replaces_streaming_text() {
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let (device, token) = h.pair_local(&owner).await;
    let (_, receipt) = h
        .bot_request(
            "POST",
            "/api/bot/tasks",
            &owner,
            json!({"request_id":id(),"prompt":"本地任务","options":{"local_device_id":device}}),
            Some("http://localhost:5173"),
        )
        .await;
    let key = receipt["id"].as_str().unwrap();
    let base = format!("/api/bot/local/tasks/{key}");
    h.bot_request(
        "POST",
        &format!("{base}/start"),
        &token,
        json!({"session_id":"shared-session"}),
        None,
    )
    .await;
    let streaming = json!({"seq":1,"turn_key":"turn:1","status":"running","result":"","messages":[{"id":id(),"content":"部","status":"streaming","created_at":now()}]});
    h.bot_request("POST", &format!("{base}/sync"), &token, streaming, None)
        .await;
    let final_frame = json!({"seq":2,"turn_key":"turn:1","status":"completed","result":"完整结果","messages":[{"id":id(),"content":"完整结果","status":"completed","created_at":now()}]});
    for _ in 0..2 {
        let (status, v) = h
            .bot_request(
                "POST",
                &format!("{base}/sync"),
                &token,
                final_frame.clone(),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{v}");
    }
    let (_, detail) = h
        .bot_request(
            "GET",
            &format!("/api/bot/tasks/{key}"),
            &owner,
            json!({}),
            None,
        )
        .await;
    assert_eq!(detail["messages"].as_array().unwrap().len(), 1);
    assert_eq!(detail["messages"][0]["content"], "完整结果");
    let (_,child)=h.bot_request("POST","/api/bot/tasks",&owner,json!({"request_id":id(),"prompt":"继续本地任务","options":{"local_device_id":device,"parent_task_id":key}}),Some("http://localhost:5173")).await;
    let (_, poll) = h
        .bot_request("POST", "/api/bot/local/poll", &token, json!({}), None)
        .await;
    assert_eq!(poll["commands"][0]["id"], child["id"]);
    assert_eq!(poll["commands"][0]["expected_session_id"], "shared-session");
}

#[tokio::test]
async fn bot_connection_requires_browser_approval_and_keeps_device_secret_private() {
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    let other = h.login("wang@atlas.local").await;
    let token = format!("zd_{}", atlas_server::auth::token());
    let input = json!({"token":token,"name":"Windows 工作电脑","workspace_id":"local-work","workspace_title":"产品研究"});
    let (status, request) = h
        .request(
            "POST",
            "/api/bot/local/connections",
            input.clone(),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let key = request["id"].as_str().unwrap();
    let (_, retry) = h
        .request("POST", "/api/bot/local/connections", input, None, None)
        .await;
    assert_eq!(request, retry);
    let route = format!("/api/bot/connections/{key}");
    let (status, _) = h.request("GET", &route, json!({}), None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, details) = h
        .request("GET", &route, json!({}), Some(&owner), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(details["workspace_title"], "产品研究");
    assert!(!details.to_string().contains(&token));
    let poll = json!({"id":key,"token":token});
    let (_, pending) = h
        .request(
            "POST",
            "/api/bot/local/connections/poll",
            poll.clone(),
            None,
            None,
        )
        .await;
    assert_eq!(pending["status"], "pending");
    let (status, _) = h
        .request(
            "POST",
            "/api/bot/local/connections/poll",
            json!({"id":key,"token":format!("zd_{}",atlas_server::auth::token())}),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let approve = format!("{route}/approve");
    let (status, _) = h
        .request("POST", &approve, json!({}), Some(&owner), None)
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "approval requires browser Origin"
    );
    let (status, device) = h
        .request(
            "POST",
            &approve,
            json!({}),
            Some(&owner),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, again) = h
        .request(
            "POST",
            &approve,
            json!({}),
            Some(&owner),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(device, again);
    let (status, _) = h
        .request(
            "POST",
            &approve,
            json!({}),
            Some(&other),
            Some("http://localhost:5173"),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, receipt) = h
        .request(
            "POST",
            "/api/bot/local/connections/poll",
            poll.clone(),
            None,
            None,
        )
        .await;
    assert_eq!(receipt["status"], "connected");
    assert_eq!(receipt["id"], device["id"]);
    let (status, devices) = h
        .request("GET", "/api/bot/devices", json!({}), Some(&owner), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(devices.as_array().unwrap().len(), 1);
    assert_eq!(devices[0]["online"], true);
    let (status, _) = h
        .request("GET", "/api/bot/devices", json!({}), Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = h
        .request(
            "POST",
            "/api/bot/local/connections/cancel",
            json!({"token":token}),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = h
        .request("POST", "/api/bot/local/connections/poll", poll, None, None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = h
        .request("POST", "/api/bot/local/poll", json!({}), Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bot_connection_expiration_cancellation_and_disabled_accounts_cannot_activate() {
    let h = Harness::new().await;
    let owner = h.login("admin@atlas.local").await;
    for mode in ["expired", "cancelled", "disabled"] {
        let token = format!("zd_{}", atlas_server::auth::token());
        let (_,request)=h.request("POST","/api/bot/local/connections",json!({"token":token,"name":"电脑","workspace_id":"work","workspace_title":"工作区"}),None,None).await;
        let key = request["id"].as_str().unwrap();
        if mode == "expired" {
            h.state
                .db
                .exec(
                    "UPDATE bot_connections SET expires_at=1 WHERE id=?",
                    vec![json!(key)],
                )
                .await
                .unwrap();
        }
        if mode == "cancelled" {
            h.request(
                "POST",
                "/api/bot/local/connections/cancel",
                json!({"token":token}),
                None,
                None,
            )
            .await;
        }
        let approve = format!("/api/bot/connections/{key}/approve");
        if mode == "disabled" {
            let (status, _) = h
                .request(
                    "POST",
                    &approve,
                    json!({}),
                    Some(&owner),
                    Some("http://localhost:5173"),
                )
                .await;
            assert_eq!(status, StatusCode::OK);
            h.state
                .db
                .exec(
                    "UPDATE users SET active=0 WHERE email='admin@atlas.local'",
                    vec![],
                )
                .await
                .unwrap();
            let (status, _) = h
                .request(
                    "POST",
                    "/api/bot/local/connections/poll",
                    json!({"id":key,"token":token}),
                    None,
                    None,
                )
                .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        } else {
            let (status, _) = h
                .request(
                    "POST",
                    &approve,
                    json!({}),
                    Some(&owner),
                    Some("http://localhost:5173"),
                )
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
    }
}
