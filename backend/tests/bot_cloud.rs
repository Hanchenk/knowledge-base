use atlas_server::{
    auth, bot_cloud,
    config::Config,
    db::{id, now},
    AppState,
};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

struct Fixture {
    state: AppState,
    router: Router,
    _temp: TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut config = Config::load().unwrap();
        config.production = false;
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.harness_enabled = true;
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("cloud.db").display()
        );
        config.storage_path = temp.path().join("files");
        config.harness_path = temp.path().join("profiles");
        config.agent_script = temp.path().join("agent.mjs").to_string_lossy().into();
        config.s3_bucket.clear();
        config.s3_endpoint.clear();
        config.s3_access_key.clear();
        config.s3_secret_key.clear();
        config.ai_api_key.clear();
        config.vision_api_key.clear();
        config.chat_model.clear();
        config.vision_model.clear();
        config.embedding_model.clear();
        tokio::fs::create_dir_all(&config.harness_path)
            .await
            .unwrap();
        tokio::fs::write(temp.path().join("harness-cloud.mjs"), r#"
import {readFile,writeFile} from 'node:fs/promises';
let text='';for await(const c of process.stdin)text+=c;
const input=JSON.parse(text);
await writeFile(input.root+'/last-command.json',JSON.stringify(input));
if(input.operation==='reap'){process.stdout.write(JSON.stringify({ok:true,reaped:[],protected:input.live_owners}));process.exit(0)}
const path=input.root+'/'+input.tenant_id+'-'+input.user_id+'.json';
let state={status:'stopped',connected:false,active_tasks:0};
try{state=JSON.parse(await readFile(path))}catch{}
if(input.operation==='connect')state={...state,status:'running',connected:true,last_activity_at:Date.now(),expires_at:Date.now()+1800000};
if(input.operation==='heartbeat'&&state.connected)state={...state,last_activity_at:Date.now(),expires_at:Date.now()+1800000};
if(input.operation==='disconnect')state={...state,status:'stopped',connected:false};
await writeFile(path,JSON.stringify(state));
process.stdout.write(JSON.stringify({ok:true,...state,active_tasks:input.active_tasks,id:'internal-id',container_name:'internal-docker-name',image:input.image,engine_version:'test-private-version',root:input.root,tenant_id:input.tenant_id,user_id:input.user_id}));
"#).await.unwrap();
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
        state.db.exec("INSERT INTO api_keys(id,tenant_id,user_id,name,prefix,secret_hash,scopes,expires_at,created_at) VALUES(?,'team-a','alice','fixture','ak_',?,'[\"bot.read\"]',?,?)",vec![json!(id()),json!(auth::hash("ak_fixture")),json!(now()+3600000),json!(now())]).await.unwrap();
        Self {
            router: atlas_server::router(state.clone()),
            state,
            _temp: temp,
        }
    }
    async fn response(
        &self,
        user: Option<&str>,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
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
        let headers = response.headers().clone();
        let data = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, data.to_vec())
    }
    async fn req(
        &self,
        user: Option<&str>,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let (status, _, data) = self.response(user, method, path, body).await;
        (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
    }
    async fn task(&self, user: &str, tenant: &str, status: &str, citations: Value) -> String {
        let key = id();
        self.state.db.exec("INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,citations,lease_until,created_at,updated_at,worker_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(tenant),json!(user),json!(id()),json!("Persistent question"),json!(format!("{user} private history")),json!(status),json!(json!({"runtime":"deepseek-harness"}).to_string()),json!(citations.to_string()),json!(now()+60000),json!(now()),json!(now()),json!(format!("fence-{key}"))]).await.unwrap();
        key
    }
    async fn artifact(&self, task: &str, tenant: &str, name: &str, data: &[u8]) -> String {
        let key = id();
        let storage_key = format!("{tenant}/bot/{task}/{key}");
        self.state.storage.put(&storage_key, data).await.unwrap();
        self.state.db.exec("INSERT INTO bot_artifacts(id,task_id,name,storage_key,size,created_at) VALUES(?,?,?,?,?,?)", vec![json!(key),json!(task),json!(name),json!(storage_key),json!(data.len()),json!(now())]).await.unwrap();
        key
    }
    async fn command(&self) -> Value {
        serde_json::from_slice(
            &tokio::fs::read(self.state.config.harness_path.join("last-command.json"))
                .await
                .unwrap(),
        )
        .unwrap()
    }
}

#[tokio::test]
async fn cloud_management_is_browser_only_scoped_and_hides_internal_details() {
    let h = Fixture::new().await;
    for (method, path) in [
        ("GET", "/api/bot/cloud"),
        ("POST", "/api/bot/cloud/connect"),
        ("POST", "/api/bot/cloud/heartbeat"),
        ("POST", "/api/bot/cloud/disconnect"),
        ("GET", "/api/bot/cloud/files"),
    ] {
        assert_eq!(
            h.req(None, method, path, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            h.req(Some("ak_fixture"), method, path, json!({})).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        h.req(Some("alice"), "GET", "/api/bot/harness", json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, connected) = h
        .req(
            Some("alice"),
            "POST",
            "/api/bot/cloud/connect",
            json!({"tenant_id":"team-b","user_id":"other","root":"/unauthorized"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{connected}");
    assert_eq!(connected["connected"], true);
    assert_eq!(connected["available"], true);
    assert_eq!(connected["state"], "running");
    assert_eq!(connected["idle_timeout_seconds"], 1800);
    for key in [
        "id",
        "container_name",
        "image",
        "engine_version",
        "root",
        "tenant_id",
        "user_id",
    ] {
        assert!(connected.get(key).is_none(), "{key} must stay private");
    }
    let command = h.command().await;
    assert_eq!(command["tenant_id"], "team-a");
    assert_eq!(command["user_id"], "alice");
    let (_, observed) = h
        .req(Some("alice"), "GET", "/api/bot/cloud", json!({}))
        .await;
    assert_eq!(observed["expires_at"], connected["expires_at"]);
    for user in ["bob", "other"] {
        let (status, data) = h.req(Some(user), "GET", "/api/bot/cloud", json!({})).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["connected"], false);
    }
    let (_, heartbeat) = h
        .req(Some("alice"), "POST", "/api/bot/cloud/heartbeat", json!({}))
        .await;
    assert_eq!(heartbeat["connected"], true);
    assert!(heartbeat["expires_at"].as_i64().unwrap() >= connected["expires_at"].as_i64().unwrap());
    h.req(
        Some("alice"),
        "POST",
        "/api/bot/cloud/disconnect",
        json!({}),
    )
    .await;
    let (_, after_disconnect) = h
        .req(Some("alice"), "POST", "/api/bot/cloud/heartbeat", json!({}))
        .await;
    assert_eq!(after_disconnect["connected"], false);
    assert!(after_disconnect["expires_at"].is_null());
}

#[tokio::test]
async fn busy_tasks_block_disconnection_and_reap_protects_only_live_cloud_owners() {
    let h = Fixture::new().await;
    h.req(Some("alice"), "POST", "/api/bot/cloud/connect", json!({}))
        .await;
    let live = h.task("alice", "team-a", "running", json!([])).await;
    let stale = h.task("bob", "team-a", "running", json!([])).await;
    let completed = h.task("other", "team-b", "completed", json!([])).await;
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET lease_until=? WHERE id=?",
            vec![json!(now() - 1), json!(stale)],
        )
        .await
        .unwrap();
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/cloud/disconnect",
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, connected) = h
        .req(Some("alice"), "POST", "/api/bot/cloud/connect", json!({}))
        .await;
    assert_eq!(connected["active_tasks"], 1);
    assert_eq!(
        h.command().await["live_tasks"],
        json!([{"tenant_id":"team-a","user_id":"alice","task_id":live,"lease_token":format!("fence-{live}")}])
    );
    let result = bot_cloud::reap(&h.state).await.unwrap();
    assert_eq!(
        result["protected"],
        json!([{"tenant_id":"team-a","user_id":"alice"}])
    );
    assert_eq!(
        h.command().await["live_tasks"],
        json!([{"tenant_id":"team-a","user_id":"alice","task_id":live,"lease_token":format!("fence-{live}")}])
    );
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='completed' WHERE id=?",
            vec![json!(live)],
        )
        .await
        .unwrap();
    let queued = h.task("alice", "team-a", "queued", json!([])).await;
    let (_, connected) = h
        .req(Some("alice"), "POST", "/api/bot/cloud/connect", json!({}))
        .await;
    assert_eq!(connected["active_tasks"], 0);
    assert_eq!(connected["pending_tasks"], 1);
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/cloud/disconnect",
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='completed' WHERE id=?",
            vec![json!(queued)],
        )
        .await
        .unwrap();
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/cloud/disconnect",
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, detail) = h
        .req(
            Some("other"),
            "GET",
            &format!("/api/bot/tasks/{completed}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["task"]["status"], "completed");
}

#[tokio::test]
async fn interactive_render_has_its_own_opaque_policy_and_rechecks_authorized_evidence() {
    let h = Fixture::new().await;
    let task = h.task("alice", "team-a", "completed", json!([])).await;
    let source = b"<!doctype html><h1>Animation</h1><svg><circle cx='20' cy='20' r='10'/></svg><script>document.querySelector('h1').textContent='Animated';</script>";
    let mut rendered = Vec::new();
    for name in ["animation.HTML", "animation.htm", "animation.svg"] {
        let file = h.artifact(&task, "team-a", name, source).await;
        let (status, headers, data) = h
            .response(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{file}/render"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "text/html; charset=utf-8");
        assert_eq!(headers["cache-control"], "private, no-store");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["referrer-policy"], "no-referrer");
        let policy = headers["content-security-policy"].to_str().unwrap();
        assert!(!policy.contains("allow-same-origin"));
        for directive in [
            "sandbox allow-scripts",
            "default-src 'none'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            "img-src data: blob:",
            "font-src data:",
            "media-src data: blob:",
            "connect-src 'none'",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'self'",
        ] {
            assert!(
                policy.split(';').any(|part| part.trim() == directive),
                "Missing isolation directive: {directive}"
            );
        }
        assert_eq!(data, source);
        // The source endpoint remains inert even for renderable files.
        let (status, headers, data) = h
            .response(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{file}/preview"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "text/plain; charset=utf-8");
        assert_eq!(
            headers["content-security-policy"],
            "sandbox; default-src 'none'"
        );
        assert_eq!(data, source);
        rendered.push(file);
    }
    let path = format!("/api/bot/artifacts/{}/render", rendered[0]);
    for (user, expected) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some("ak_fixture"), StatusCode::FORBIDDEN),
        (Some("bob"), StatusCode::NOT_FOUND),
        (Some("other"), StatusCode::NOT_FOUND),
    ] {
        assert_eq!(h.req(user, "GET", &path, json!({})).await.0, expected);
    }
    let unsupported = h.artifact(&task, "team-a", "code.md", source).await;
    let invalid = h
        .artifact(&task, "team-a", "invalid.html", &[0xff, 0xfe])
        .await;
    for file in [&unsupported, &invalid] {
        assert_eq!(
            h.req(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{file}/render"),
                json!({})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    // Unreferenced but model-visible evidence also gates interactive content.
    h.state.db.exec("INSERT INTO spaces(id,tenant_id,name,created_by,created_at) VALUES('render-space','team-a','Private animation source','alice',?)", vec![json!(now())]).await.unwrap();
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('render-grant','render-space','user','alice',1)", vec![]).await.unwrap();
    h.state.db.exec("INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,version,indexed_version,status,created_by,created_at,updated_at) VALUES('render-document','team-a','render-space','Reference','reference.txt','text/plain','unused',1,'unused',1,1,'ready','alice',?,?)", vec![json!(now()),json!(now())]).await.unwrap();
    let restricted = h.task("alice", "team-a", "completed", json!([{"space_id":"render-space","document_id":"render-document","version":1,"referenced":false}])).await;
    let file = h
        .artifact(&restricted, "team-a", "private.html", source)
        .await;
    let path = format!("/api/bot/artifacts/{file}/render");
    assert_eq!(
        h.req(Some("alice"), "GET", &path, json!({})).await.0,
        StatusCode::OK
    );
    h.state
        .db
        .exec(
            "UPDATE grants SET can_view=0 WHERE id='render-grant'",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        h.req(Some("alice"), "GET", &path, json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    h.state
        .db
        .exec(
            "UPDATE grants SET can_view=1 WHERE id='render-grant'",
            vec![],
        )
        .await
        .unwrap();
    h.state
        .db
        .exec(
            "UPDATE documents SET version=2 WHERE id='render-document'",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        h.req(Some("alice"), "GET", &path, json!({})).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn reconnect_retains_tasks_and_private_files_with_safe_online_previews() {
    let h = Fixture::new().await;
    let task = h.task("alice", "team-a", "completed", json!([])).await;
    h.state.db.exec("INSERT INTO bot_messages(task_id,id,content,status,created_at,updated_at) VALUES(?,?,?,'completed',?,?)",vec![json!(task),json!(id()),json!("会话重连后保留的完整回答"),json!(now()),json!(now())]).await.unwrap();
    let text = b"<script>alert('must be plain text')</script>\nPersistent result";
    let report = h.artifact(&task, "team-a", "report.md", text).await;
    let png = include_bytes!("../../tests/fixtures/diagram.png");
    let image = h.artifact(&task, "team-a", "diagram.PNG", png).await;
    let pdf = h
        .artifact(&task, "team-a", "report.pdf", b"%PDF-1.4\nfixture")
        .await;
    let html = h.artifact(&task, "team-a", "page.html", text).await;
    let fake_image = h.artifact(&task, "team-a", "disguised.png", text).await;
    let revoked_task = h
        .task(
            "alice",
            "team-a",
            "completed",
            json!([{"space_id":"revoked-space","document_id":"missing-document","version":1}]),
        )
        .await;
    let revoked_file = h
        .artifact(
            &revoked_task,
            "team-a",
            "hidden-private-title.md",
            b"hidden",
        )
        .await;
    let foreign = h.task("bob", "team-a", "completed", json!([])).await;
    let foreign_file = h
        .artifact(&foreign, "team-a", "bob-private-file.md", b"bob")
        .await;
    for operation in ["connect", "disconnect", "connect"] {
        assert_eq!(
            h.req(
                Some("alice"),
                "POST",
                &format!("/api/bot/cloud/{operation}"),
                json!({})
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let permission = h.command().await;
    assert!(permission["authorized_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(task)));
    assert!(permission["restricted_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(revoked_task)));
    assert!(!permission["authorized_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(foreign)));
    let (status, detail) = h
        .req(
            Some("alice"),
            "GET",
            &format!("/api/bot/tasks/{task}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["messages"][0]["content"], "会话重连后保留的完整回答");
    let (status, files) = h
        .req(Some("alice"), "GET", "/api/bot/cloud/files", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{files}");
    assert_eq!(files["files"].as_array().unwrap().len(), 5);
    assert!(!files.to_string().contains("hidden-private-title"));
    assert!(!files.to_string().contains("bob-private-file"));
    for suffix in ["", "/preview"] {
        assert_eq!(
            h.req(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{revoked_file}{suffix}"),
                json!({})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let listed = files["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == html)
        .unwrap();
    assert_eq!(listed["previewable"], true);
    assert_eq!(listed["kind"], "text");
    assert_eq!(listed["content_type"], "text/plain; charset=utf-8");
    assert_eq!(
        listed["preview_url"],
        format!("/api/bot/artifacts/{html}/preview")
    );
    for file in [&report, &html] {
        let (status, headers, data) = h
            .response(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{file}/preview"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "text/plain; charset=utf-8");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["cache-control"], "private, no-store");
        assert_eq!(
            headers["content-security-policy"],
            "sandbox; default-src 'none'"
        );
        assert_eq!(data, text);
    }
    for (file, content_type) in [(&image, "image/png"), (&pdf, "application/pdf")] {
        let (status, headers, _) = h
            .response(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{file}/preview"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], content_type);
    }
    let invalid_html = h
        .artifact(&task, "team-a", "invalid.html", &[0xff, 0xfe])
        .await;
    for file in [&invalid_html, &fake_image] {
        assert_eq!(
            h.req(
                Some("alice"),
                "GET",
                &format!("/api/bot/artifacts/{file}/preview"),
                json!({})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for file in [&report, &html, &foreign_file] {
        let wrong_user = if file == &foreign_file {
            "alice"
        } else {
            "bob"
        };
        assert_eq!(
            h.req(
                Some(wrong_user),
                "GET",
                &format!("/api/bot/artifacts/{file}/preview"),
                json!({})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        h.req(
            Some("other"),
            "GET",
            &format!("/api/bot/artifacts/{image}/preview"),
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, _, download) = h
        .response(
            Some("alice"),
            "GET",
            &format!("/api/bot/artifacts/{image}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(download, png);
    let (status, history) = h
        .req(Some("alice"), "GET", "/api/bot/tasks", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(history.as_array().unwrap().iter().any(|v| v["id"] == task));
    for path in [
        "/api/bot/cloud/files?limit=0",
        "/api/bot/cloud/files?limit=101",
        "/api/bot/cloud/files?offset=10001",
    ] {
        assert_eq!(
            h.req(Some("alice"), "GET", path, json!({})).await.0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn revoked_native_history_access_tracks_permissions_and_filtered_pages_advance() {
    let h = Fixture::new().await;
    h.state.db.exec("INSERT INTO spaces(id,tenant_id,name,created_by,created_at) VALUES('source-space','team-a','Private source','alice',?)",vec![json!(now())]).await.unwrap();
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('source-grant','source-space','user','alice',1)",vec![]).await.unwrap();
    h.state.db.exec("INSERT INTO documents(id,tenant_id,space_id,title,filename,mime_type,storage_key,size,checksum,status,created_by,created_at,updated_at) VALUES('source-document','team-a','source-space','Private source','source.txt','text/plain','team-a/source.txt',1,'fixture','ready','alice',?,?)",vec![json!(now()),json!(now())]).await.unwrap();
    let safe = h.task("alice", "team-a", "completed", json!([])).await;
    let safe_file = h
        .artifact(&safe, "team-a", "safe.md", b"public facts")
        .await;
    let private = h
        .task(
            "alice",
            "team-a",
            "completed",
            json!([{"space_id":"source-space","document_id":"source-document","version":1}]),
        )
        .await;
    let private_file = h
        .artifact(&private, "team-a", "private.md", b"private facts")
        .await;
    h.state
        .db
        .exec(
            "UPDATE bot_artifacts SET created_at=100 WHERE id=?",
            vec![json!(safe_file)],
        )
        .await
        .unwrap();
    h.state
        .db
        .exec(
            "UPDATE bot_artifacts SET created_at=200 WHERE id=?",
            vec![json!(private_file)],
        )
        .await
        .unwrap();
    h.req(Some("alice"), "POST", "/api/bot/cloud/connect", json!({}))
        .await;
    assert!(h.command().await["authorized_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(private)));
    h.state
        .db
        .exec("DELETE FROM grants WHERE id='source-grant'", vec![])
        .await
        .unwrap();
    h.req(Some("alice"), "GET", "/api/bot/cloud", json!({}))
        .await;
    let command = h.command().await;
    assert!(command["restricted_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(private)));
    assert!(!command["authorized_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(private)));
    let (status, first) = h
        .req(
            Some("alice"),
            "GET",
            "/api/bot/cloud/files?limit=1",
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["files"], json!([]));
    assert_eq!(first["has_more"], true);
    assert_eq!(first["next_offset"], 1);
    let (status, second) = h
        .req(
            Some("alice"),
            "GET",
            "/api/bot/cloud/files?limit=1&offset=1",
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["files"][0]["id"], safe_file);
    assert_eq!(second["has_more"], false);
    assert!(second["next_offset"].is_null());
    assert_eq!(
        h.req(
            Some("alice"),
            "GET",
            &format!("/api/bot/artifacts/{private_file}/preview"),
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    h.state.db.exec("INSERT INTO grants(id,space_id,principal_type,principal_id,can_view) VALUES('source-grant','source-space','user','alice',1)",vec![]).await.unwrap();
    h.req(Some("alice"), "POST", "/api/bot/cloud/connect", json!({}))
        .await;
    assert!(h.command().await["authorized_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(private)));
    h.state
        .db
        .exec(
            "UPDATE documents SET version=2 WHERE id='source-document'",
            vec![],
        )
        .await
        .unwrap();
    h.req(Some("alice"), "POST", "/api/bot/cloud/connect", json!({}))
        .await;
    assert!(h.command().await["restricted_task_ids"]
        .as_array()
        .unwrap()
        .contains(&json!(private)));
    let (status, history) = h
        .req(Some("alice"), "GET", "/api/bot/tasks", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(history
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["id"] == private));
}
