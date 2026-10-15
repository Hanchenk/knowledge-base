use atlas_server::{
    auth::{self, Actor},
    config::Config,
    db::{id, n, now, s},
    models, studio, AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, State},
    http::{Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use tower::ServiceExt;

fn png() -> Vec<u8> {
    STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==").unwrap()
}
struct Harness {
    state: AppState,
    router: Router,
    _temp: TempDir,
}
impl Harness {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut config = Config::load().unwrap();
        config.production = false;
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("studio.db").display()
        );
        config.storage_path = temp.path().join("files");
        config.s3_endpoint.clear();
        config.s3_bucket.clear();
        config.s3_access_key.clear();
        config.s3_secret_key.clear();
        config.qdrant_url.clear();
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.ai_api_key.clear();
        config.vision_api_key.clear();
        config.chat_api_key.clear();
        config.vision_model.clear();
        config.chat_model.clear();
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
            state.db.exec("INSERT INTO users(id,tenant_id,email,name,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)",vec![json!(user),json!(tenant),json!(format!("{user}@test.local")),json!(user),json!("unused"),json!(now())]).await.unwrap();
            state
                .db
                .exec(
                    "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
                    vec![json!(auth::hash(user)), json!(user), json!(now() + 3600000)],
                )
                .await
                .unwrap();
        }
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
        body: Vec<u8>,
        mime: &str,
    ) -> (StatusCode, Vec<u8>) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", mime)
            .header("origin", "http://127.0.0.1:5173");
        if let Some(user) = user {
            request = request.header("cookie", format!("atlas_session={user}"));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        (
            response.status(),
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
    }
    async fn upload(&self, user: &str, name: &str, bytes: &[u8]) -> (StatusCode, Value) {
        let mut body=format!("--studio-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend(bytes);
        body.extend(b"\r\n--studio-boundary--\r\n");
        let (status, body) = self
            .req(
                Some(user),
                "POST",
                "/api/studio/attachments",
                body,
                "multipart/form-data; boundary=studio-boundary",
            )
            .await;
        (status, serde_json::from_slice(&body).unwrap())
    }
    async fn context(
        &self,
        base: &str,
        model: &str,
        kind: &str,
        refs: &[(&str, &str)],
    ) -> studio::Context {
        let actor = self.actor();
        let project = id();
        let request = id();
        self.state.db.exec("INSERT INTO studio_projects(id,tenant_id,user_id,title,created_at,updated_at) VALUES(?,'team-a','alice','测试',?,?)",vec![json!(project),json!(now()),json!(now())]).await.unwrap();
        for (position, (key, role)) in refs.iter().enumerate() {
            self.state.db.exec("INSERT INTO studio_request_inputs(project_id,request_id,attachment_id,role,position) VALUES(?,?,?,?,?)",vec![json!(project),json!(request),json!(key),json!(role),json!(position as i64)]).await.unwrap();
        }
        let (mut settings, _) = models::load(&self.state, &actor.tenant_id).await.unwrap();
        let provider = models::Provider {
            enabled: true,
            base_url: base.into(),
            model: model.into(),
            api_key: "private-media-key".into(),
            dimensions: 0,
        };
        settings.image = provider.clone();
        settings.video = provider;
        studio::Context {
            project_id: project,
            request_id: request,
            kind: kind.into(),
            image_size: "1024x1024".into(),
            video_size: "1280x720".into(),
            seconds: 4,
            settings,
            operation: "generate".into(),
            quality: "auto".into(),
            style: String::new(),
            image_count: refs.iter().filter(|(_, role)| *role == "reference").count(),
        }
    }
    fn actor(&self) -> Actor {
        Actor {
            id: "alice".into(),
            tenant_id: "team-a".into(),
            department_id: String::new(),
            role: "member".into(),
            scopes: None,
            key_id: None,
        }
    }
}

#[tokio::test]
async fn submitted_requests_freeze_prompt_parameters_and_reference_order() {
    let mut h = Harness::new().await;
    let script = h._temp.path().join("fixture-agent.mjs");
    tokio::fs::write(&script, r#"import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin}); let started=false;
input.on('line',()=>{if(!started){started=true;process.stdout.write(JSON.stringify({type:'tool_call',id:'generate',name:'generate_image',args:{prompt:'保留主体，修改选区'}})+'\n');}
else{process.stdout.write(JSON.stringify({type:'result',answer:'已提交生成任务'})+'\n');input.close();}});"#).await.unwrap();
    let cfg = Arc::make_mut(&mut h.state.config);
    cfg.agent_enabled = true;
    cfg.agent_node = "node".into();
    cfg.agent_script = script.to_string_lossy().into();
    h.router = atlas_server::router(h.state.clone());
    let mut admin = h.actor();
    admin.role = "admin".into();
    let provider = |enabled, model| json!({"enabled":enabled,"base_url":"http://127.0.0.1:1/v1","model":model,"api_key":"fixture-key","dimensions":768});
    let settings = json!({"revision":0,"chat":provider(true,"fixture-chat"),"embedding":provider(false,"fixture-embedding"),"vision":provider(false,"fixture-vision"),"image":provider(true,"fixture-image")});
    let _ = models::save(
        State(h.state.clone()),
        admin,
        Json(serde_json::from_value(settings).unwrap()),
    )
    .await
    .unwrap();
    let (_, image) = h.upload("alice", "photo.png", &png()).await;
    let (_, other) = h.upload("alice", "other.png", &png()).await;
    let (_, mask) = h.upload("alice", "mask.png", &png()).await;
    let (_, other_mask) = h.upload("alice", "other-mask.png", &png()).await;
    let project = id();
    h.state.db.exec("INSERT INTO studio_projects(id,tenant_id,user_id,title,created_at,updated_at) VALUES(?,'team-a','alice','冻结输入',?,?)",vec![json!(project),json!(now()),json!(now())]).await.unwrap();
    let request = id();
    let body = json!({"project_id":project,"request_id":request,"prompt":"修改衣服颜色","kind":"image","image_size":"1024x1024","video_size":"1280x720","seconds":4,"operation":"edit","style":"ink","image_quality":"high","attachment_ids":[image["id"],other["id"]],"mask_attachment_id":mask["id"]});
    for _ in 0..2 {
        let (status, reply) = h
            .req(
                Some("alice"),
                "POST",
                "/api/studio/chat",
                serde_json::to_vec(&body).unwrap(),
                "application/json",
            )
            .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&reply)
        );
    }
    for (field, value) in [
        ("prompt", json!("更改原任务")),
        ("attachment_ids", json!([other["id"], image["id"]])),
        ("attachment_ids", json!([other["id"]])),
        ("mask_attachment_id", other_mask["id"].clone()),
        ("image_quality", json!("low")),
        ("style", json!("oil")),
    ] {
        let mut changed = body.clone();
        changed[field] = value;
        let (status, reply) = h
            .req(
                Some("alice"),
                "POST",
                "/api/studio/chat",
                serde_json::to_vec(&changed).unwrap(),
                "application/json",
            )
            .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "{}",
            String::from_utf8_lossy(&reply)
        );
    }
    let inputs=h.state.db.rows("SELECT attachment_id,role FROM studio_request_inputs WHERE project_id=? AND request_id=? ORDER BY position",vec![json!(project),json!(request)]).await.unwrap();
    assert_eq!(inputs.len(), 3);
    assert_eq!(inputs[0]["attachment_id"], image["id"]);
    assert_eq!(inputs[1]["attachment_id"], other["id"]);
    assert_eq!(inputs[2]["attachment_id"], mask["id"]);
    assert_eq!(inputs[2]["role"], "mask");
    let jobs=h.state.db.rows("SELECT j.id,o.operation,o.quality,o.style FROM studio_jobs j JOIN studio_job_options o ON o.job_id=j.id WHERE j.project_id=? AND j.request_id=?",vec![json!(project),json!(request)]).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(s(&jobs[0], "operation"), "edit");
    assert_eq!(s(&jobs[0], "quality"), "high");
    assert_eq!(s(&jobs[0], "style"), "ink");
    let messages = h
        .state
        .db
        .one(
            "SELECT COUNT(*) AS count FROM studio_messages WHERE project_id=? AND request_id=?",
            vec![json!(project), json!(request)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n(&messages, "count"), 2);
}

#[tokio::test]
async fn references_are_private_validated_and_retained_when_used() {
    let h = Harness::new().await;
    assert_eq!(
        h.req(
            None,
            "GET",
            "/api/studio/attachments/missing",
            vec![],
            "application/json"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.upload("alice", "malicious.svg", b"<svg></svg>").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.upload("alice", "fake.png", b"not an image").await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, image) = h.upload("alice", "photo.png", &png()).await;
    assert_eq!(status, StatusCode::OK, "{image}");
    assert_eq!(image["kind"], "image");
    assert!(image.get("storage_key").is_none());
    let key = image["id"].as_str().unwrap();
    let path = format!("/api/studio/attachments/{key}");
    let (status, bytes) = h
        .req(Some("alice"), "GET", &path, vec![], "application/json")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, png());
    for user in ["bob", "other"] {
        assert_eq!(
            h.req(Some(user), "GET", &path, vec![], "application/json")
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            h.req(Some(user), "DELETE", &path, vec![], "application/json")
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    let (_, text) = h
        .upload("alice", "brief.md", "产品：蓝色水杯；价格：99元".as_bytes())
        .await;
    let row =
        atlas_server::studio_inputs::owned(&h.state, &h.actor(), text["id"].as_str().unwrap())
            .await
            .unwrap();
    assert!(s(&row, "extracted_text").contains("99元"));
    let (status, office) = h
        .upload(
            "alice",
            "monthly-report.xlsx",
            include_bytes!("../../tests/fixtures/monthly-report.xlsx"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{office}");
    let row =
        atlas_server::studio_inputs::owned(&h.state, &h.actor(), office["id"].as_str().unwrap())
            .await
            .unwrap();
    assert!(!s(&row, "extracted_text").is_empty());
    assert_eq!(
        h.upload("alice", "invalid.txt", &[0xff, 0xfe]).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.upload("alice", "large.txt", &vec![b'a'; 2 * 1024 * 1024 + 1])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert!(
        atlas_server::studio_inputs::selected(&h.state, &h.actor(), &vec![key.to_owned(); 9])
            .await
            .is_err()
    );
    let _context = h
        .context(
            "http://127.0.0.1:1",
            "fixture",
            "image",
            &[(key, "reference")],
        )
        .await;
    assert_eq!(
        h.req(Some("alice"), "DELETE", &path, vec![], "application/json")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let text_path = format!("/api/studio/attachments/{}", text["id"].as_str().unwrap());
    assert_eq!(
        h.req(
            Some("alice"),
            "DELETE",
            &text_path,
            vec![],
            "application/json"
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        h.req(Some("alice"), "GET", &text_path, vec![], "application/json")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<Value>>>);
async fn edit(State(captured): State<Captured>, mut multipart: Multipart) -> Json<Value> {
    let mut fields = serde_json::Map::new();
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_owned();
        let filename = field.file_name().map(str::to_owned);
        let bytes = field.bytes().await.unwrap();
        fields.insert(
            name,
            if let Some(filename) = filename {
                json!({"filename":filename,"bytes":STANDARD.encode(bytes)})
            } else {
                json!(String::from_utf8(bytes.to_vec()).unwrap())
            },
        );
    }
    captured
        .0
        .lock()
        .unwrap()
        .push(json!({"path":"edit","fields":fields}));
    Json(json!({"data":[{"b64_json":STANDARD.encode(png())}]}))
}
async fn generate(State(captured): State<Captured>, Json(body): Json<Value>) -> Json<Value> {
    captured
        .0
        .lock()
        .unwrap()
        .push(json!({"path":"generate","fields":body}));
    Json(json!({"data":[{"b64_json":STANDARD.encode(png())}]}))
}
async fn fixture(routes: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    (
        base,
        tokio::spawn(async move {
            axum::serve(listener, routes).await.unwrap();
        }),
    )
}
#[tokio::test]
async fn image_edits_forward_original_and_mask_with_selected_parameters_without_fallback() {
    let h = Harness::new().await;
    let (_, image) = h.upload("alice", "photo.png", &png()).await;
    let (_, mask) = h.upload("alice", "mask.png", &png()).await;
    let capture = Captured::default();
    let routes = Router::new()
        .route("/images/edits", post(edit))
        .route("/images/generations", post(generate))
        .with_state(capture.clone());
    let (base, server) = fixture(routes).await;
    let mut context = h
        .context(
            &base,
            "fixture-image",
            "image",
            &[
                (image["id"].as_str().unwrap(), "reference"),
                (mask["id"].as_str().unwrap(), "mask"),
            ],
        )
        .await;
    context.operation = "edit".into();
    context.quality = "high".into();
    context.style = "watercolor".into();
    let queued = studio::queue(&h.state, &h.actor(), &context, "image", "只修改选区")
        .await
        .unwrap();
    studio::queue(&h.state, &h.actor(), &context, "image", "只修改选区")
        .await
        .unwrap();
    assert!(studio::run_one(&h.state).await.unwrap());
    let calls = capture.0.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["path"], "edit");
    assert_eq!(calls[0]["fields"]["quality"], "high");
    assert!(calls[0]["fields"]["prompt"]
        .as_str()
        .unwrap()
        .contains("水彩画"));
    assert_eq!(calls[0]["fields"]["image"]["bytes"], STANDARD.encode(png()));
    assert_eq!(calls[0]["fields"]["mask"]["bytes"], STANDARD.encode(png()));
    let key = queued["job"]["id"].as_str().unwrap();
    assert_eq!(
        h.state
            .db
            .one(
                "SELECT status FROM studio_jobs WHERE id=?",
                vec![json!(key)]
            )
            .await
            .unwrap()
            .unwrap()["status"],
        "completed"
    );
    server.abort();
    let (base, server) = fixture(
        Router::new()
            .route("/images/generations", post(generate))
            .with_state(capture.clone()),
    )
    .await;
    let context = h
        .context(
            &base,
            "fixture-no-edits",
            "image",
            &[(image["id"].as_str().unwrap(), "reference")],
        )
        .await;
    let queued = studio::queue(&h.state, &h.actor(), &context, "image", "参考图创作")
        .await
        .unwrap();
    assert!(studio::run_one(&h.state).await.unwrap());
    let job = h
        .state
        .db
        .one(
            "SELECT status,error FROM studio_jobs WHERE id=?",
            vec![queued["job"]["id"].clone()],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job["status"], "failed");
    assert!(s(&job, "error").contains("/images/edits"));
    assert_eq!(
        capture.0.lock().unwrap().len(),
        1,
        "must not submit a paid text-to-image fallback"
    );
    server.abort();
}

#[tokio::test]
async fn image_to_video_forwards_reference_in_both_supported_protocols() {
    let h = Harness::new().await;
    let (_, image) = h.upload("alice", "photo.png", &png()).await;
    let capture = Captured::default();
    let routes = Router::new()
        .route(
            "/videos",
            post(
                |State(captured): State<Captured>, mut multipart: Multipart| async move {
                    let mut fields = serde_json::Map::new();
                    while let Some(field) = multipart.next_field().await.unwrap() {
                        let name = field.name().unwrap().to_owned();
                        let bytes = field.bytes().await.unwrap();
                        fields.insert(
                            name.clone(),
                            if name == "input_reference" {
                                json!(STANDARD.encode(bytes))
                            } else {
                                json!(String::from_utf8(bytes.to_vec()).unwrap())
                            },
                        );
                    }
                    captured.0.lock().unwrap().push(json!({"fields":fields}));
                    Json(json!({"id":"openai-video"}))
                },
            ),
        )
        .route(
            "/videos/generations",
            post(
                |State(captured): State<Captured>, Json(body): Json<Value>| async move {
                    captured.0.lock().unwrap().push(body);
                    Json(json!({"request_id":"grok-video"}))
                },
            ),
        )
        .route(
            "/videos/{id}",
            get(|| async { Json(json!({"status":"completed"})) }),
        )
        .route(
            "/videos/{id}/content",
            get(|| async { include_bytes!("../../tests/fixtures/studio-video.mp4").to_vec() }),
        )
        .with_state(capture.clone());
    let (base, server) = fixture(routes).await;
    for model in ["sora-fixture", "grok-imagine-video-fixture"] {
        let context = h
            .context(
                &base,
                model,
                "video",
                &[(image["id"].as_str().unwrap(), "reference")],
            )
            .await;
        studio::queue(&h.state, &h.actor(), &context, "video", "让画面动起来")
            .await
            .unwrap();
        assert!(studio::run_one(&h.state).await.unwrap());
    }
    let calls = capture.0.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0]["fields"]["input_reference"],
        STANDARD.encode(png())
    );
    assert_eq!(
        calls[1]["image"]["url"],
        format!("data:image/png;base64,{}", STANDARD.encode(png()))
    );
    server.abort();
}
