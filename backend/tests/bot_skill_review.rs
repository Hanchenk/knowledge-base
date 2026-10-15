use atlas_server::{
    auth::{self, Actor},
    bot, bot_skill_review,
    config::Config,
    core_skill_registry,
    db::{id, now},
    memory_provider, AppState,
};
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tempfile::TempDir;
use tower::ServiceExt;
#[path = "support/extraction_receipt_tests.rs"]
mod extraction_receipt_tests;
#[path = "support/native_registry.rs"]
mod native_registry;
#[path = "support/native_registry_tests.rs"]
mod native_registry_tests;
#[path = "support/skill_capture_tests.rs"]
mod skill_capture_tests;

struct Fixture {
    state: AppState,
    router: Router,
    _temp: TempDir,
}
impl Fixture {
    async fn new(core_url: Option<&str>, chat_url: Option<&str>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut config = Config::load().unwrap();
        config.production = false;
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("skills.db").display()
        );
        config.storage_path = temp.path().join("files");
        config.s3_bucket.clear();
        config.s3_endpoint.clear();
        config.s3_access_key.clear();
        config.s3_secret_key.clear();
        config.qdrant_url.clear();
        config.ai_api_key.clear();
        config.vision_api_key.clear();
        config.chat_base_url = chat_url.unwrap_or("").into();
        config.chat_api_key = "chat-fixture-secret".into();
        config.chat_model = if chat_url.is_some() {
            "fixture-model"
        } else {
            ""
        }
        .into();
        config.vision_model.clear();
        config.embedding_model.clear();
        config.memory_core_url = core_url.unwrap_or("").into();
        config.memory_core_token = "core-fixture-secret".into();
        config.memory_core_admin_user_key = "registry-admin-secret".into();
        config.memory_knowledge_url.clear();
        let state = AppState::new(config).await.unwrap();
        for team in ["team-a", "team-b"] {
            state
                .db
                .exec(
                    "INSERT INTO tenants(id,slug,name) VALUES(?,?,?)",
                    vec![json!(team), json!(team), json!(team)],
                )
                .await
                .unwrap();
        }
        for (user, team) in [("alice", "team-a"), ("bob", "team-a"), ("other", "team-b")] {
            state.db.exec("INSERT INTO users(id,tenant_id,email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)",vec![json!(user),json!(team),json!(format!("{user}@test.local")),json!(user),json!("unused"),json!(now())]).await.unwrap();
            state
                .db
                .exec(
                    "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
                    vec![json!(auth::hash(user)), json!(user), json!(now() + 3600000)],
                )
                .await
                .unwrap();
        }
        state.db.exec("INSERT INTO api_keys(id,tenant_id,user_id,name,prefix,secret_hash,scopes,expires_at,created_at) VALUES(?,'team-a','alice','fixture','ak_',?,'[\"bot.read\",\"bot.write\"]',?,?)",vec![json!(id()),json!(auth::hash("ak_fixture")),json!(now()+3600000),json!(now())]).await.unwrap();
        Self {
            router: atlas_server::router(state.clone()),
            state,
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
            .header("content-type", "application/json")
            .header("origin", "http://127.0.0.1:5173");
        if let Some(user) = user {
            request = if user.starts_with("ak_") {
                request.header("authorization", format!("Bearer {user}"))
            } else {
                request.header("cookie", format!("atlas_session={user}"))
            };
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
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn task(&self, user: &str, team: &str, status: &str, citations: Value) -> String {
        let key = id();
        self.state.db.exec("INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,plan,result,citations,worker_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(team),json!(user),json!(id()),json!("汇总会议行动项"),json!("会议工作流"),json!(status),json!("{}"),json!("[{\"title\":\"核对负责人\",\"status\":\"completed\"}]"),json!("已生成带负责人与截止日期的行动项，未知字段标记待确认。"),json!(citations.to_string()),json!(format!("fence-{key}")),json!(now()),json!(now())]).await.unwrap();
        key
    }
    async fn draft(&self, task: &str) -> Value {
        let (status,value)=self.req(Some("alice"),"POST","/api/bot/skill-candidates",json!({"task_id":task,"name":"核对会议行动项","description":"会议整理","instructions":"读取授权资料；核对负责人和日期；缺少字段标记待确认；保存行动项。","tenant_id":"team-b","user_id":"other","status":"approved"})).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    async fn approve(&self, candidate: &Value) -> Value {
        let path = format!(
            "/api/bot/skill-candidates/{}/review",
            candidate["id"].as_str().unwrap()
        );
        let (status, value) = self
            .req(
                Some("alice"),
                "POST",
                &path,
                json!({"decision":"approve","note":"已核对方法","version":candidate["version"]}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    fn actor(&self, user: &str, team: &str) -> Actor {
        Actor {
            id: user.into(),
            tenant_id: team.into(),
            department_id: String::new(),
            role: "member".into(),
            scopes: None,
            key_id: None,
        }
    }
    async fn document(&self) -> Value {
        self.state.db.exec("INSERT INTO spaces(id,tenant_id,name,created_by,created_at) VALUES('source-space','team-a','Private source','alice',?)",vec![json!(now())]).await.unwrap();
        self.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('source-grant','source-space','user','alice',1)",vec![]).await.unwrap();
        self.state.db.exec("INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,created_by,created_at,updated_at) VALUES('source-document','team-a','source-space','Secret meeting','meeting.txt','text/plain','unused',1,'unused','alice',?,?)",vec![json!(now()),json!(now())]).await.unwrap();
        json!({"document_id":"source-document","space_id":"source-space","version":1})
    }
}

#[tokio::test]
async fn only_browser_owner_of_a_completed_task_can_propose_edit_and_review() {
    let fixture = Fixture::new(None, None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    for user in [None, Some("ak_fixture"), Some("bob"), Some("other")] {
        let expected = match user {
            None => StatusCode::UNAUTHORIZED,
            Some("ak_fixture") => StatusCode::FORBIDDEN,
            _ => StatusCode::NOT_FOUND,
        };
        assert_eq!(
            fixture
                .req(
                    user,
                    "POST",
                    "/api/bot/skill-candidates",
                    json!({"task_id":task,"instructions":"明确输入，核对结果"})
                )
                .await
                .0,
            expected
        );
    }
    for status in ["running", "failed", "cancelled", "queued"] {
        let incomplete = fixture.task("alice", "team-a", status, json!([])).await;
        assert_eq!(
            fixture
                .req(
                    Some("alice"),
                    "POST",
                    "/api/bot/skill-candidates",
                    json!({"task_id":incomplete,"instructions":"不要凭空认可失败方法"})
                )
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let candidate = fixture.draft(&task).await;
    assert_eq!(candidate["status"], "pending");
    assert!(candidate["skill_id"].is_null());
    let key = candidate["id"].as_str().unwrap();
    for user in ["bob", "other", "ak_fixture"] {
        let expected = if user == "ak_fixture" {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::NOT_FOUND
        };
        for (method, path, body) in [
            (
                "PUT",
                format!("/api/bot/skill-candidates/{key}"),
                json!({"instructions":"override"}),
            ),
            (
                "POST",
                format!("/api/bot/skill-candidates/{key}/review"),
                json!({"decision":"approve"}),
            ),
            (
                "DELETE",
                format!("/api/bot/skill-candidates/{key}"),
                json!({}),
            ),
        ] {
            assert_eq!(
                fixture.req(Some(user), method, &path, body).await.0,
                expected
            );
        }
    }
    for user in ["bob", "other"] {
        assert_eq!(
            fixture
                .req(Some(user), "GET", "/api/bot/skill-candidates", json!({}))
                .await
                .1,
            json!([])
        );
    }
    let usable = fixture
        .req(Some("alice"), "GET", "/api/bot/skills", json!({}))
        .await
        .1;
    assert!(usable
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["id"] != candidate["id"]));
    assert!(bot_skill_review::validate_skill(
        &fixture.state,
        &fixture.actor("alice", "team-a"),
        key
    )
    .await
    .is_err());
}

#[tokio::test]
async fn review_uses_exact_version_and_publishes_once_then_delete_revokes_skill() {
    let fixture = Fixture::new(None, None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let candidate = fixture.draft(&task).await;
    let path = format!(
        "/api/bot/skill-candidates/{}",
        candidate["id"].as_str().unwrap()
    );
    let (status, edited) = fixture
        .req(
            Some("alice"),
            "PUT",
            &path,
            json!({"instructions":"核对输入；标记待确认；交付文件；回查数字。","version":1}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["version"], 2);
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &format!("{path}/review"),
                json!({"decision":"approve","version":1})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let approved = fixture.approve(&edited).await;
    let skill = approved["skill_id"].as_str().unwrap();
    assert_eq!(approved["status"], "approved");
    assert_eq!(approved["version"], 3);
    bot_skill_review::validate_skill(&fixture.state, &fixture.actor("alice", "team-a"), skill)
        .await
        .unwrap();
    assert!(bot_skill_review::validate_skill(
        &fixture.state,
        &fixture.actor("bob", "team-a"),
        skill
    )
    .await
    .is_err());
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &format!("{path}/review"),
                json!({"decision":"approve"})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "PUT",
                &path,
                json!({"instructions":"changed after review"})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let record = fixture
        .state
        .db
        .one("SELECT COUNT(*) AS count FROM bot_skills", vec![])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record["count"], 1);
    assert_eq!(
        fixture
            .req(Some("alice"), "DELETE", &path, json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert!(bot_skill_review::validate_skill(
        &fixture.state,
        &fixture.actor("alice", "team-a"),
        skill
    )
    .await
    .is_err());
    assert!(fixture
        .state
        .db
        .one("SELECT id FROM bot_skills WHERE id=?", vec![json!(skill)])
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn revoked_or_changed_source_hides_candidate_and_prevents_reuse_even_transitively() {
    let fixture = Fixture::new(None, None).await;
    let citation = fixture.document().await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([citation]))
        .await;
    let candidate = fixture.draft(&task).await;
    let approved = fixture.approve(&candidate).await;
    let skill = approved["skill_id"].as_str().unwrap();
    let child_task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_tasks SET options=? WHERE id=?",
            vec![
                json!(json!({"skill_ids":[skill]}).to_string()),
                json!(child_task),
            ],
        )
        .await
        .unwrap();
    let derived = fixture.approve(&fixture.draft(&child_task).await).await;
    fixture
        .state
        .db
        .exec(
            "UPDATE grants SET can_view=0 WHERE id='source-grant'",
            vec![],
        )
        .await
        .unwrap();
    for selected in [skill, derived["skill_id"].as_str().unwrap()] {
        assert_eq!(
            bot_skill_review::validate_skill(
                &fixture.state,
                &fixture.actor("alice", "team-a"),
                selected
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let values = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert!(values
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["source_valid"] == false
            && v["instructions"] == ""
            && v["name"] == ""
            && v["citations"] == json!([])));
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                "/api/bot/skill-candidates",
                json!({"task_id":task,"instructions":"should not expose old records"})
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    fixture
        .state
        .db
        .exec(
            "UPDATE grants SET can_view=1 WHERE id='source-grant'",
            vec![],
        )
        .await
        .unwrap();
    fixture
        .state
        .db
        .exec(
            "UPDATE documents SET version=2 WHERE id='source-document'",
            vec![],
        )
        .await
        .unwrap();
    assert!(bot_skill_review::validate_skill(
        &fixture.state,
        &fixture.actor("alice", "team-a"),
        skill
    )
    .await
    .is_err());
}

#[tokio::test]
async fn source_snapshot_and_document_space_binding_cannot_be_bypassed() {
    let fixture = Fixture::new(None, None).await;
    let citation = fixture.document().await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([citation]))
        .await;
    let candidate = fixture.draft(&task).await;
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_tasks SET result='different result' WHERE id=?",
            vec![json!(task)],
        )
        .await
        .unwrap();
    let path = format!(
        "/api/bot/skill-candidates/{}/review",
        candidate["id"].as_str().unwrap()
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "POST", &path, json!({"decision":"approve"}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Source-invalid candidates can still be rejected and deleted by their owner.
    assert_eq!(
        fixture
            .req(Some("alice"), "POST", &path, json!({"decision":"reject"}))
            .await
            .0,
        StatusCode::OK
    );
    fixture.state.db.exec("INSERT INTO spaces(id,tenant_id,name,created_by,created_at) VALUES('public-space','team-a','Public','alice',?)",vec![json!(now())]).await.unwrap();
    fixture.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('public-grant','public-space','user','alice',1)",vec![]).await.unwrap();
    fixture
        .state
        .db
        .exec("DELETE FROM grants WHERE id='source-grant'", vec![])
        .await
        .unwrap();
    let spoof = fixture
        .task(
            "alice",
            "team-a",
            "completed",
            json!([{"document_id":"source-document","space_id":"public-space","version":1}]),
        )
        .await;
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                "/api/bot/skill-candidates",
                json!({"task_id":spoof,"instructions":"cannot borrow unrelated rights"})
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn harness_can_only_draft_with_a_live_lease_and_explicit_instructions() {
    let fixture = Fixture::new(None, None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let active = fixture.task("alice", "team-a", "running", json!([])).await;
    let actor = fixture.actor("alice", "team-a");
    let mut context = bot::Context {
        task_id: active.clone(),
        token: format!("fence-{active}"),
        options: bot::Options::default(),
        connectors: vec![],
    };
    assert!(bot_skill_review::tool_propose(
        &fixture.state,
        &actor,
        &context,
        &json!({"task_id":source})
    )
    .await
    .is_err());
    let draft=bot_skill_review::tool_propose(&fixture.state,&actor,&context,&json!({"task_id":source,"name":"Agent draft","instructions":"Validate inputs then verify output","decision":"approve"})).await.unwrap();
    assert_eq!(draft["origin"], "agent");
    assert_eq!(draft["status"], "pending");
    assert!(draft["skill_id"].is_null());
    context.token = "stale-fence".into();
    assert!(bot_skill_review::tool_propose(
        &fixture.state,
        &actor,
        &context,
        &json!({"task_id":source,"instructions":"stale agent must not write"})
    )
    .await
    .is_err());
}

#[derive(Clone, Default)]
struct Mock {
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    ready: Arc<AtomicBool>,
    delete_fail: Arc<AtomicBool>,
    detail_foreign: Arc<AtomicBool>,
    detail_missing_owner: Arc<AtomicBool>,
    extract_fail_after: Arc<AtomicBool>,
    extract_missing_ack: Arc<AtomicBool>,
    extract_pause: Arc<AtomicBool>,
    extract_started: Arc<tokio::sync::Notify>,
    extract_release: Arc<tokio::sync::Notify>,
    second_result: Arc<AtomicBool>,
    second_get_started: Arc<tokio::sync::Notify>,
    second_get_release: Arc<tokio::sync::Notify>,
}
struct Provider {
    url: String,
    mock: Mock,
    registry: native_registry::NativeRegistry,
    handle: tokio::task::JoinHandle<()>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.handle.abort();
    }
}
impl Provider {
    async fn new() -> Self {
        let mock = Mock::default();
        let registry = native_registry::NativeRegistry::default();
        async fn extract(
            State(mock): State<Mock>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            mock.requests.lock().unwrap().push(("extract".into(), body));
            mock.extract_started.notify_one();
            if mock.extract_pause.load(Ordering::SeqCst) {
                mock.extract_release.notified().await;
            }
            if mock.extract_fail_after.load(Ordering::SeqCst) {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":50301})));
            }
            if mock.extract_missing_ack.load(Ordering::SeqCst) {
                return (StatusCode::OK, Json(json!({"code":0,"data":{"ok":true}})));
            }
            (
                StatusCode::OK,
                Json(
                    json!({"code":0,"data":{"ok":true,"task_id":"archive-1","archived_at_ms":now(),"archive_key":"private/archive"}}),
                ),
            )
        }
        async fn list(State(mock): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
            mock.requests
                .lock()
                .unwrap()
                .push(("list".into(), body.clone()));
            let mut items = if mock.ready.load(Ordering::SeqCst) {
                json!([
                    {"skill_id":"skl-result","task_id":"archive-1","status":"active","name":"Meeting checklist","version":1},
                    {"skill_id":"skl-unrelated","task_id":"other-task","status":"active","name":"Not this extraction","version":1},
                    {"skill_id":"skl-foreign","task_id":"archive-1","status":"active","owner_agent_id":"foreign-agent","name":"Wrong owner","version":1}
                ])
            } else {
                json!([])
            };
            if mock.ready.load(Ordering::SeqCst) && mock.second_result.load(Ordering::SeqCst) {
                items.as_array_mut().unwrap().push(json!({"skill_id":"skl-second","task_id":"archive-1","status":"active","name":"Second result","version":1}));
            }
            for item in items.as_array_mut().unwrap() {
                let item = item.as_object_mut().unwrap();
                item.entry("team_id")
                    .or_insert_with(|| body["team_id"].clone());
                item.entry("owner_user_id")
                    .or_insert_with(|| body["user_id"].clone());
                item.entry("owner_agent_id")
                    .or_insert_with(|| body["agent_id"].clone());
            }
            Json(json!({"code":0,"data":{"items":items,"total":items.as_array().unwrap().len()}}))
        }
        async fn get(State(mock): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
            mock.requests
                .lock()
                .unwrap()
                .push(("get".into(), body.clone()));
            if body["skill_id"] == "skl-second" {
                mock.second_get_started.notify_one();
                mock.second_get_release.notified().await;
            }
            let mut value = json!({"code":0,"data":{"skill_id":"skl-result","task_id":"archive-1","team_id":body["team_id"],"owner_user_id":body["user_id"],"owner_agent_id":body["agent_id"],"status":"active","name":"Meeting checklist","description":"Verified meeting steps","version":1,"content":"Require meeting input; confirm owners and dates; flag gaps; verify saved output."}});
            value["data"]["skill_id"] = body["skill_id"].clone();
            if mock.detail_foreign.load(Ordering::SeqCst) {
                value["data"]["owner_user_id"] = json!("foreign-user");
            }
            if mock.detail_missing_owner.load(Ordering::SeqCst) {
                value["data"]
                    .as_object_mut()
                    .unwrap()
                    .remove("owner_agent_id");
            }
            Json(value)
        }
        async fn delete(
            State(mock): State<Mock>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            mock.requests.lock().unwrap().push(("delete".into(), body));
            if mock.delete_fail.load(Ordering::SeqCst) {
                (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":50301})))
            } else {
                (
                    StatusCode::OK,
                    Json(json!({"code":0,"data":{"archived":true}})),
                )
            }
        }
        async fn chat(State(mock): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
            mock.requests.lock().unwrap().push(("chat".into(), body));
            Json(
                json!({"choices":[{"message":{"content":json!({"name":"核对会议行动项","description":"模型提炼的待审核工作流","instructions":"核对资料；填写负责人和日期；未知字段标记待确认；核查成果。"}).to_string()}}]}),
            )
        }
        async fn core(State(mock): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
            mock.requests.lock().unwrap().push(("core".into(), body));
            Json(json!({"code":0,"data":{"items":[]}}))
        }
        let app = Router::new()
            .route("/v3/skill/extract", post(extract))
            .route("/v3/skill/list", post(list))
            .route("/v3/skill/get", post(get))
            .route("/v3/skill/delete", post(delete))
            .route("/chat/completions", post(chat))
            .route("/v3/core/read", post(core))
            .with_state(mock.clone())
            .merge(registry.router());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            mock,
            registry,
            handle,
        }
    }
}

#[tokio::test]
async fn tencent_extraction_acknowledgement_is_not_a_skill_and_only_correlated_results_are_reviewable(
) {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (status, queued) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":task,"user_id":"other","team_id":"team-b","agent_id":"evil-agent"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{queued}");
    assert_eq!(queued["origin"], "memory_core");
    assert_eq!(queued["extraction_state"], "queued");
    assert_eq!(queued["instructions"], "");
    let path = format!(
        "/api/bot/skill-candidates/{}/review",
        queued["id"].as_str().unwrap()
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "POST", &path, json!({"decision":"approve"}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let first = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(first[0]["extraction_state"], "queued");
    provider.mock.ready.store(true, Ordering::SeqCst);
    let ready = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(ready.as_array().unwrap().len(), 1);
    assert_eq!(ready[0]["extraction_state"], "ready");
    assert_eq!(ready[0]["name"], "Meeting checklist");
    assert!(!ready[0]["instructions"].as_str().unwrap().is_empty());
    let approved = fixture.approve(&ready[0]).await;
    assert!(approved["skill_id"].is_string());
    let requests = provider.mock.requests.lock().unwrap();
    let extract = &requests.iter().find(|r| r.0 == "extract").unwrap().1;
    assert_ne!(extract["user_id"], "other");
    assert_ne!(extract["team_id"], "team-b");
    assert_ne!(extract["agent_id"], "evil-agent");
    assert_eq!(extract["strict_mode"], true);
    assert!(requests
        .iter()
        .filter(|r| r.0 == "get")
        .all(|r| r.1["skill_id"] == "skl-result"));
}

#[tokio::test]
async fn model_distillation_is_real_and_manual_proposals_work_without_a_model() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(None, Some(&provider.url)).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (status, candidate) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":task}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{candidate}");
    assert_eq!(candidate["origin"], "model");
    assert_eq!(candidate["status"], "pending");
    assert!(provider
        .mock
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.0 == "chat" && r.1["model"] == "fixture-model"));
    let no_model = Fixture::new(None, None).await;
    let source = no_model
        .task("alice", "team-a", "completed", json!([]))
        .await;
    assert_eq!(
        no_model
            .req(
                Some("alice"),
                "POST",
                "/api/bot/skill-candidates",
                json!({"task_id":source})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(no_model.draft(&source).await["origin"], "manual");
}

#[tokio::test]
async fn candidate_drafts_are_encrypted_and_ciphertext_is_bound_to_its_owner_and_row() {
    let fixture = Fixture::new(None, None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let first = fixture.draft(&task).await;
    let second = fixture.draft(&task).await;
    let raw = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_skill_candidates WHERE id=?",
            vec![first["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    for field in ["name", "description", "instructions", "review_note"] {
        assert_eq!(raw[field], "");
    }
    assert_eq!(raw["citations"], "[]");
    assert!(!raw["encrypted_draft"].as_str().unwrap().contains("核对"));
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_skill_candidates SET encrypted_draft=? WHERE id=?",
            vec![raw["encrypted_draft"].clone(), second["id"].clone()],
        )
        .await
        .unwrap();
    let (status, response) = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
    assert!(response.get("instructions").is_none());
}

#[tokio::test]
async fn foreign_remote_detail_stays_queued_and_rejected_remote_skills_have_durable_cleanup_retries(
) {
    let provider = Provider::new().await;
    provider.mock.ready.store(true, Ordering::SeqCst);
    provider.mock.detail_foreign.store(true, Ordering::SeqCst);
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (status, queued) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":task}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{queued}");
    let foreign = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(foreign[0]["extraction_state"], "queued");
    assert_eq!(foreign[0]["instructions"], "");
    provider.mock.detail_foreign.store(false, Ordering::SeqCst);
    let ready = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    let path = format!(
        "/api/bot/skill-candidates/{}/review",
        ready[0]["id"].as_str().unwrap()
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "POST", &path, json!({"decision":"reject"}))
            .await
            .0,
        StatusCode::OK
    );
    provider.mock.delete_fail.store(true, Ordering::SeqCst);
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    let tombstone = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_skill_cleanup WHERE id=?",
            vec![queued["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone["status"], "pending");
    assert_eq!(tombstone["attempts"], 1);
    assert_eq!(tombstone["upstream_skill_id"], "skl-result");
    provider.mock.delete_fail.store(false, Ordering::SeqCst);
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_skill_cleanup SET next_attempt_at=?",
            vec![json!(now() - 1)],
        )
        .await
        .unwrap();
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    let tombstone = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_skill_cleanup WHERE id=?",
            vec![queued["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone["status"], "completed");
    assert_eq!(tombstone["attempts"], 2);
    assert!(fixture
        .state
        .db
        .rows("SELECT id FROM bot_skills", vec![])
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn deleting_queued_extraction_retains_tombstone_and_cleans_only_its_late_results() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (status, queued) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":task}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{queued}");
    let path = format!(
        "/api/bot/skill-candidates/{}",
        queued["id"].as_str().unwrap()
    );
    let (status, deleted) = fixture.req(Some("alice"), "DELETE", &path, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["remote_cleanup_pending"], true);
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    provider.mock.ready.store(true, Ordering::SeqCst);
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_skill_cleanup SET next_attempt_at=?",
            vec![json!(now() - 1)],
        )
        .await
        .unwrap();
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    {
        let requests = provider.mock.requests.lock().unwrap();
        let deletes: Vec<_> = requests.iter().filter(|r| r.0 == "delete").collect();
        assert_eq!(deletes.len(), 1);
        assert_eq!(deletes[0].1["skill_id"], "skl-result");
    }
    let tombstone = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_skill_cleanup WHERE id=?",
            vec![queued["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone["status"], "pending");
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
            .await
            .1,
        json!([])
    );
}

#[tokio::test]
async fn existing_skill_delete_revokes_derived_candidate_and_queues_upstream_cleanup() {
    let provider = Provider::new().await;
    provider.mock.ready.store(true, Ordering::SeqCst);
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let task = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (status, queued) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":task}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{queued}");
    let ready = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    let approved = fixture.approve(&ready[0]).await;
    let skill = approved["skill_id"].as_str().unwrap();
    let (status, deleted) = fixture
        .req(
            Some("alice"),
            "DELETE",
            &format!("/api/bot/skills/{skill}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert!(fixture
        .state
        .db
        .one("SELECT id FROM bot_skills WHERE id=?", vec![json!(skill)])
        .await
        .unwrap()
        .is_none());
    assert!(fixture
        .state
        .db
        .one(
            "SELECT id FROM bot_skill_candidates WHERE id=?",
            vec![queued["id"].clone()]
        )
        .await
        .unwrap()
        .is_none());
    let tombstone = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_skill_cleanup WHERE id=?",
            vec![queued["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone["status"], "pending");
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    let tombstone = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_skill_cleanup WHERE id=?",
            vec![queued["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone["status"], "completed");
    assert!(provider
        .mock
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(op, body)| op == "delete" && body["skill_id"] == "skl-result"));
}

#[tokio::test]
async fn branching_skill_provenance_traverses_deep_task_graph_once_and_preserves_revocation() {
    let fixture = Fixture::new(None, None).await;
    let citation = fixture.document().await;
    let mut previous = Vec::<String>::new();
    let mut latest = String::new();
    for index in 0..45 {
        let source = fixture
            .task(
                "alice",
                "team-a",
                "completed",
                if index == 0 {
                    json!([citation.clone()])
                } else {
                    json!([])
                },
            )
            .await;
        let dependencies: Vec<_> = previous.iter().rev().take(2).cloned().collect();
        fixture
            .state
            .db
            .exec(
                "UPDATE bot_tasks SET options=? WHERE id=?",
                vec![
                    json!(json!({"skill_ids":dependencies}).to_string()),
                    json!(source),
                ],
            )
            .await
            .unwrap();
        let approved = fixture.approve(&fixture.draft(&source).await).await;
        latest = approved["skill_id"].as_str().unwrap().to_owned();
        previous.push(latest.clone());
    }
    let actor = fixture.actor("alice", "team-a");
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        bot_skill_review::validate_skill(&fixture.state, &actor, &latest),
    )
    .await
    .unwrap()
    .unwrap();
    fixture
        .state
        .db
        .exec(
            "UPDATE grants SET can_view=0 WHERE id='source-grant'",
            vec![],
        )
        .await
        .unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_secs(5),
        bot_skill_review::validate_skill(&fixture.state, &actor, &latest)
    )
    .await
    .unwrap()
    .is_err());
}
