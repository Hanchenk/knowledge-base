use atlas_server::{
    agent, auth,
    bot::{self, Context, Options},
    bot_knowledge,
    config::Config,
    db::{now, s, Db},
    AppState,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Request, StatusCode},
    routing::post,
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tower::ServiceExt;

type ProviderCall = (String, Value, String, String);

#[derive(Clone, Default)]
struct Provider {
    calls: Arc<Mutex<Vec<ProviderCall>>>,
    db: Arc<Mutex<Option<Db>>>,
    revoke_on_read: Arc<AtomicBool>,
    fail_purge: Arc<AtomicBool>,
    fail_create_ack: Arc<AtomicBool>,
    hide_created: Arc<AtomicBool>,
}
async fn service(
    State(state): State<Provider>,
    Path(path): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.calls.lock().await.push((
        path.clone(),
        body.clone(),
        headers
            .get("x-tdai-service-id")
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    ));
    if path == "wiki/create" && state.fail_create_ack.load(Ordering::SeqCst) {
        // The service created its resource but its acknowledgement failed.
        return Json(json!({"code":500,"message":"acknowledgement unavailable","data":null}));
    }
    let data = match path.as_str() {
        "wiki/create" => json!({"wiki_id":"wiki-abcdefgh","status":"draft","version":"1"}),
        "wiki/raw/write" => json!({"items":[{"filename":"accepted.md"}]}),
        "wiki/ingest" => json!({"wiki_id":"wiki-abcdefgh","status":"pending"}),
        "wiki/get" => {
            json!({"wiki_id":"wiki-abcdefgh","status":"ready","page_count":1,"version":"1"})
        }
        "tools/call" => {
            if state.revoke_on_read.swap(false, Ordering::SeqCst) {
                state
                    .db
                    .lock()
                    .await
                    .as_ref()
                    .unwrap()
                    .exec("DELETE FROM grants WHERE principal_id='alice'", vec![])
                    .await
                    .unwrap();
            }
            json!({"results":[{"path":"wiki/topics/fixture.md","title":"Fixture page","snippet":"Derived secret knowledge","score":1.0,"type":"topic"}],"links":[],"count":1})
        }
        "wiki/delete" => {
            if state.fail_purge.load(Ordering::SeqCst) {
                json!({"deleted_ids":[],"failed":[{"id":"wiki-abcdefgh","reason":"delete failed"}]})
            } else {
                json!({"deleted_ids":["wiki-abcdefgh"],"failed":[]})
            }
        }
        "wiki/list" => {
            let calls = state.calls.lock().await;
            let created = calls.iter().rev().find(|v| v.0 == "wiki/create");
            match created {
                Some(created) if !state.hide_created.load(Ordering::SeqCst) => {
                    let request = &created.1;
                    json!({"items":[{"wiki_id":"wiki-abcdefgh","team_id":request["team_id"],"name":request["name"],"status":"draft"}],"total":1})
                }
                _ => json!({"items":[],"total":0}),
            }
        }
        _ => panic!("unexpected upstream path {path}"),
    };
    Json(json!({"code":0,"message":"ok","data":data}))
}
struct Harness {
    state: AppState,
    router: Router,
    provider: Provider,
    server: tokio::task::JoinHandle<()>,
    _temp: TempDir,
}
impl Harness {
    async fn new(configured: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let provider = Provider::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v3/{*path}", post(service))
            .with_state(provider.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = Config::load().unwrap();
        config.production = false;
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.harness_enabled = false;
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("knowledge.db").display()
        );
        config.storage_path = temp.path().join("files");
        config.harness_path = temp.path().join("profiles");
        config.s3_bucket.clear();
        config.s3_endpoint.clear();
        config.s3_access_key.clear();
        config.s3_secret_key.clear();
        config.ai_api_key.clear();
        config.vision_api_key.clear();
        config.chat_model.clear();
        config.vision_model.clear();
        config.embedding_model.clear();
        config.memory_core_url.clear();
        config.memory_core_token.clear();
        config.memory_knowledge_url = if configured {
            format!("http://{address}")
        } else {
            String::new()
        };
        config.memory_knowledge_token = if configured {
            "fixture-token".into()
        } else {
            String::new()
        };
        let state = AppState::new(config).await.unwrap();
        *provider.db.lock().await = Some(state.db.clone());
        for tenant in ["team-a", "team-b"] {
            state
                .db
                .exec(
                    "INSERT INTO tenants(id,slug,name) VALUES(?,?,?)",
                    vec![json!(tenant), json!(tenant), json!(tenant)],
                )
                .await
                .unwrap();
        }
        for (user, tenant) in [("alice", "team-a"), ("bob", "team-a"), ("other", "team-b")] {
            state.db.exec("INSERT INTO users(id,tenant_id,email,name,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)",vec![json!(user),json!(tenant),json!(format!("{user}@example.test")),json!(user),json!("unused"),json!(now())]).await.unwrap();
            state
                .db
                .exec(
                    "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
                    vec![
                        json!(auth::hash(user)),
                        json!(user),
                        json!(now() + 3_600_000),
                    ],
                )
                .await
                .unwrap();
        }
        state.db.exec("INSERT INTO spaces(id,tenant_id,name,created_by,created_at) VALUES('source-space','team-a','Source','alice',?)",vec![json!(now())]).await.unwrap();
        state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('source-grant','source-space','user','alice',1)",vec![]).await.unwrap();
        state.db.exec("INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,version,indexed_version,status,created_by,created_at,updated_at) VALUES('source-doc','team-a','source-space','Authorized document','source.md','text/markdown','unused',100,'unused',2,2,'ready','alice',?,?)",vec![json!(now()),json!(now())]).await.unwrap();
        for (key, version, text) in [
            ("chunk-old", 1, "Old excluded content"),
            ("chunk-current", 2, "Current authorized source content"),
        ] {
            state.db.exec("INSERT INTO chunks(id,tenant_id,space_id,document_id,version,text,search_tokens,page,kind,position) VALUES(?,'team-a','source-space','source-doc',?,?,?,1,'text',0)",vec![json!(key),json!(version),json!(text),json!(text)]).await.unwrap();
        }
        let router = atlas_server::router(state.clone());
        Self {
            state,
            router,
            provider,
            server,
            _temp: temp,
        }
    }
    async fn req(
        &self,
        user: Option<&str>,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("origin", "http://127.0.0.1:5173")
            .header("content-type", "application/json");
        if let Some(user) = user {
            request = request.header("cookie", format!("atlas_session={user}"));
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
        (
            response.status(),
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap_or(Value::Null),
        )
    }
    async fn create_wiki(&self) -> String {
        let (status, data) = self
            .req(
                Some("alice"),
                "POST",
                "/api/bot/knowledge/assets",
                json!({"kind":"wiki","name":"Fixture wiki","document_ids":["source-doc"]}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{data}");
        data["id"].as_str().unwrap().into()
    }
    async fn ready(&self, key: &str) {
        assert!(bot_knowledge::tick(&self.state).await.unwrap());
        self.state
            .db
            .exec(
                "UPDATE bot_knowledge_assets SET available_at=0 WHERE id=?",
                vec![json!(key)],
            )
            .await
            .unwrap();
        assert!(bot_knowledge::tick(&self.state).await.unwrap());
        assert_eq!(
            s(
                &self
                    .state
                    .db
                    .one(
                        "SELECT status FROM bot_knowledge_assets WHERE id=?",
                        vec![json!(key)]
                    )
                    .await
                    .unwrap()
                    .unwrap(),
                "status"
            ),
            "ready"
        );
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn provider_ingestion_uses_current_authorized_chunks_and_private_ids() {
    let h = Harness::new(true).await;
    let key = h.create_wiki().await;
    h.ready(&key).await;
    let calls = h.provider.calls.lock().await.clone();
    assert_eq!(
        calls.iter().map(|v| v.0.as_str()).collect::<Vec<_>>(),
        vec!["wiki/create", "wiki/raw/write", "wiki/ingest", "wiki/get"]
    );
    let upload = &calls.iter().find(|v| v.0 == "wiki/raw/write").unwrap().1;
    let text = upload["files"][0]["content"].as_str().unwrap();
    assert!(text.contains("Current authorized source content"));
    assert!(!text.contains("Old excluded content"));
    assert!(text.contains("版本 2"));
    assert!(calls
        .iter()
        .all(|v| v.2 == h.state.config.memory_service_id && v.3 == "Bearer fixture-token"));
    let alice = atlas_server::auth::Actor {
        id: "alice".into(),
        tenant_id: "team-a".into(),
        department_id: String::new(),
        role: "member".into(),
        scopes: None,
        key_id: None,
    };
    assert_eq!(
        calls[0].1["team_id"],
        atlas_server::memory_provider::identity(&alice, true)["team_id"]
    );
    for user in ["bob", "other"] {
        assert!(h
            .req(Some(user), "GET", "/api/bot/knowledge/assets", json!({}))
            .await
            .1["items"]
            .as_array()
            .unwrap()
            .is_empty());
        for (method, suffix, body) in [
            ("GET", "", json!({})),
            ("DELETE", "", json!({})),
            ("POST", "/sync", json!({})),
            ("POST", "/search", json!({"query":"fact"})),
        ] {
            assert_eq!(
                h.req(
                    Some(user),
                    method,
                    &format!("/api/bot/knowledge/assets/{key}{suffix}"),
                    body
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
    }
    let response = h
        .req(
            Some("alice"),
            "GET",
            &format!("/api/bot/knowledge/assets/{key}"),
            json!({}),
        )
        .await
        .1;
    assert!(response.get("provider_id").is_none());
    assert_eq!(response["metadata"]["page_count"], 1);
    let context = Context {
        task_id: "fixture-task".into(),
        token: "fixture".into(),
        options: Options::default(),
        connectors: vec![],
    };
    assert_eq!(
        bot_knowledge::tool(
            &h.state,
            &alice,
            &context,
            "wiki_search",
            json!({"asset_id":key,"query":"fact"})
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn revoked_or_replaced_sources_never_release_wiki_results() {
    let h = Harness::new(true).await;
    let key = h.create_wiki().await;
    h.ready(&key).await;
    let path = format!("/api/bot/knowledge/assets/{key}/search");
    h.state
        .db
        .exec(
            "UPDATE documents SET version=3,indexed_version=3 WHERE id='source-doc'",
            vec![],
        )
        .await
        .unwrap();
    let count = h.provider.calls.lock().await.len();
    assert_eq!(
        h.req(Some("alice"), "POST", &path, json!({"query":"fact"}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.provider.calls.lock().await.len(), count);
    h.state
        .db
        .exec(
            "UPDATE documents SET version=2,indexed_version=2 WHERE id='source-doc'",
            vec![],
        )
        .await
        .unwrap();
    h.provider.revoke_on_read.store(true, Ordering::SeqCst);
    let (status, result) = h
        .req(Some("alice"), "POST", &path, json!({"query":"fact"}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!result.to_string().contains("Derived secret knowledge"));
    let count = h.provider.calls.lock().await.len();
    assert_eq!(
        h.req(Some("alice"), "POST", &path, json!({"query":"fact"}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.provider.calls.lock().await.len(), count);
}

#[tokio::test]
async fn deletion_tombstones_before_durable_remote_purge() {
    let h = Harness::new(true).await;
    let key = h.create_wiki().await;
    h.ready(&key).await;
    h.provider.fail_purge.store(true, Ordering::SeqCst);
    assert_eq!(
        h.req(
            Some("alice"),
            "DELETE",
            &format!("/api/bot/knowledge/assets/{key}"),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            &format!("/api/bot/knowledge/assets/{key}/search"),
            json!({"query":"secret"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(bot_knowledge::tick(&h.state).await.unwrap());
    let row = h
        .state
        .db
        .one(
            "SELECT * FROM bot_knowledge_assets WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "deleting");
    assert_eq!(s(&row, "provider_id"), "wiki-abcdefgh");
    h.provider.fail_purge.store(false, Ordering::SeqCst);
    h.state
        .db
        .exec(
            "UPDATE bot_knowledge_assets SET available_at=0 WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    assert!(bot_knowledge::tick(&h.state).await.unwrap());
    let row = h
        .state
        .db
        .one(
            "SELECT * FROM bot_knowledge_assets WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "deleted");
    assert_eq!(s(&row, "provider_id"), "");
}

#[tokio::test]
async fn disabled_provider_and_untrusted_repository_sources_are_explicit() {
    let disabled = Harness::new(false).await;
    assert_eq!(
        disabled
            .req(Some("alice"), "GET", "/api/bot/knowledge/assets", json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        disabled
            .req(
                Some("alice"),
                "POST",
                "/api/bot/knowledge/assets",
                json!({"kind":"wiki","name":"Wiki","document_ids":["source-doc"]})
            )
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let h = Harness::new(true).await;
    for repository_url in [
        "http://127.0.0.1/private",
        "https://github.com/user/repo?token=secret",
        "git@github.com:user/repo.git",
        "https://user:secret@github.com/user/repo",
    ] {
        assert_eq!(
            h.req(
                Some("alice"),
                "POST",
                "/api/bot/knowledge/assets",
                json!({"kind":"code_graph","name":"Graph","repository_url":repository_url})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert!(h.provider.calls.lock().await.is_empty());
}

#[tokio::test]
async fn bridge_wiki_citations_and_receipts_fence_saved_results_and_cached_calls() {
    let h = Harness::new(true).await;
    let key = h.create_wiki().await;
    h.ready(&key).await;
    let actor = auth::Actor {
        id: "alice".into(),
        tenant_id: "team-a".into(),
        department_id: String::new(),
        role: "member".into(),
        scopes: None,
        key_id: None,
    };
    let options = Options {
        memory_enabled: false,
        knowledge_asset_ids: vec![key.clone()],
        ..Default::default()
    };
    let task_id = "knowledge-bridge-task";
    h.state.db.exec("INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,worker_token,lease_until,created_at,updated_at) VALUES(?,'team-a','alice',?,'Wiki test','Wiki test','running',?,'fixture-lease',?,?,?)",
        vec![json!(task_id),json!(task_id),json!(json!(options).to_string()),json!(now()+60_000),json!(now()),json!(now())]).await.unwrap();
    let context = Context {
        task_id: task_id.into(),
        token: "fixture-lease".into(),
        options,
        connectors: vec![],
    };
    let row = h
        .state
        .db
        .one("SELECT * FROM bot_tasks WHERE id=?", vec![json!(task_id)])
        .await
        .unwrap()
        .unwrap();
    let args = json!({"asset_id":key,"query":"fact"});
    assert!(bot::begin_call(
        &h.state,
        &actor,
        &context,
        "wiki-call",
        "wiki_search",
        &args
    )
    .await
    .unwrap()
    .is_none());
    let result = agent::bridge_tool(
        &h.state,
        &actor,
        context.clone(),
        "wiki_search",
        args.clone(),
        &row,
    )
    .await
    .unwrap();
    assert_eq!(result["citations"][0]["chunk_id"], "chunk-current");
    assert_eq!(result["citations"][0]["document_id"], "source-doc");
    assert_eq!(result["citations"][0]["version"], 2);
    let saved = h
        .state
        .db
        .one("SELECT * FROM bot_tasks WHERE id=?", vec![json!(task_id)])
        .await
        .unwrap()
        .unwrap();
    let citations: Value = serde_json::from_str(s(&saved, "citations")).unwrap();
    assert_eq!(citations[0]["chunk_id"], "chunk-current");
    let receipt = h
        .state
        .db
        .one(
            "SELECT * FROM bot_context_receipts WHERE task_id=? AND kind='knowledge'",
            vec![json!(task_id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&receipt, "context_id"), key);
    let reply = json!({"ok":true,"data":result});
    bot::finish_call(&h.state, &actor, &context, "wiki-call", &reply)
        .await
        .unwrap();
    let journal = h
        .state
        .db
        .one(
            "SELECT * FROM bot_tool_calls WHERE task_id=? AND call_id='wiki-call'",
            vec![json!(task_id)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&journal, "status"), "completed");
    assert!(!s(&journal, "encrypted_result").contains("Derived secret knowledge"));
    assert_eq!(
        bot::begin_call(
            &h.state,
            &actor,
            &context,
            "wiki-call",
            "wiki_search",
            &args
        )
        .await
        .unwrap()
        .unwrap(),
        reply
    );
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET result='Derived secret knowledge' WHERE id=?",
            vec![json!(task_id)],
        )
        .await
        .unwrap();
    h.state
        .db
        .exec("DELETE FROM grants WHERE principal_id='alice'", vec![])
        .await
        .unwrap();
    let revoked = h
        .req(
            Some("alice"),
            "GET",
            &format!("/api/bot/tasks/{task_id}"),
            json!({}),
        )
        .await
        .1;
    assert_eq!(revoked["evidence_available"], false);
    assert!(!revoked.to_string().contains("Derived secret knowledge"));
    assert!(bot::begin_call(
        &h.state,
        &actor,
        &context,
        "wiki-call",
        "wiki_search",
        &args
    )
    .await
    .is_err());
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('restored-grant','source-space','user','alice',1)",vec![]).await.unwrap();
    assert_eq!(
        h.req(
            Some("alice"),
            "DELETE",
            &format!("/api/bot/knowledge/assets/{key}"),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(bot::begin_call(
        &h.state,
        &actor,
        &context,
        "wiki-call",
        "wiki_search",
        &args
    )
    .await
    .is_err());
    let deleted = h
        .req(
            Some("alice"),
            "GET",
            &format!("/api/bot/tasks/{task_id}"),
            json!({}),
        )
        .await
        .1;
    assert_eq!(deleted["evidence_available"], false);
    assert!(!deleted.to_string().contains("Derived secret knowledge"));
}

#[tokio::test]
async fn uncertain_create_delete_waits_for_acknowledged_remote_cleanup() {
    let h = Harness::new(true).await;
    let key = h.create_wiki().await;
    h.provider.fail_create_ack.store(true, Ordering::SeqCst);
    assert!(bot_knowledge::tick(&h.state).await.unwrap());
    let row = h
        .state
        .db
        .one(
            "SELECT * FROM bot_knowledge_assets WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "provider_id"), "");
    assert_eq!(row["create_uncertain"], 1);
    h.req(
        Some("alice"),
        "DELETE",
        &format!("/api/bot/knowledge/assets/{key}"),
        json!({}),
    )
    .await;
    h.provider.hide_created.store(true, Ordering::SeqCst);
    assert!(bot_knowledge::tick(&h.state).await.unwrap());
    let row = h
        .state
        .db
        .one(
            "SELECT * FROM bot_knowledge_assets WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "deleting");
    assert_eq!(row["create_uncertain"], 1);
    assert!(s(&row, "error").contains("尚未确认"));
    h.provider.hide_created.store(false, Ordering::SeqCst);
    h.state
        .db
        .exec(
            "UPDATE bot_knowledge_assets SET available_at=0 WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    assert!(bot_knowledge::tick(&h.state).await.unwrap());
    let row = h
        .state
        .db
        .one(
            "SELECT * FROM bot_knowledge_assets WHERE id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "deleted");
    assert_eq!(row["create_uncertain"], 0);
    let calls = h.provider.calls.lock().await;
    assert_eq!(
        calls.iter().map(|v| v.0.as_str()).collect::<Vec<_>>(),
        vec!["wiki/create", "wiki/list", "wiki/list", "wiki/delete"]
    );
}
