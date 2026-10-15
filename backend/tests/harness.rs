use atlas_server::{
    auth::{self, Actor},
    bot::{self, Context, Options},
    config::Config,
    db::{id, now, s},
    AppState,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

struct Harness {
    state: AppState,
    router: Router,
    _temp: TempDir,
}
impl Harness {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let manager = temp.path().join("harness-manager.mjs");
        tokio::fs::write(&manager,r#"let text=''; for await (const c of process.stdin) text+=c;
const input=JSON.parse(text);
const data=input.operation==='inspect'?{config_rows:[{id:'fixture-row',name:'Fixture plugin'}]}:input.operation==='status'?{installed_version:'0.2.0-rc.2'}:{ok:true};
process.stdout.write(JSON.stringify({ok:true,data})+'\n');"#).await.unwrap();
        let mut config = Config::load().unwrap();
        config.production = false;
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.harness_enabled = false;
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("harness.db").display()
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
        state.db.exec("INSERT INTO api_keys(id,tenant_id,user_id,name,prefix,secret_hash,scopes,expires_at,created_at) VALUES(?,'team-a','alice','fixture','ak_',?,'[\"document.read\"]',?,?)",vec![json!(id()),json!(auth::hash("ak_fixture")),json!(now()+3600000),json!(now())]).await.unwrap();
        state.db.exec("INSERT INTO bot_harness_plugins(tenant_id,user_id,name,source,version,description,enabled,updated_at) VALUES('team-a','alice','fixture-plugin','fixture-plugin','1.0.0','Only Alice',1,?)",vec![json!(now())]).await.unwrap();
        state.db.exec("INSERT INTO bot_harness_marketplaces(id,tenant_id,user_id,name,source,created_at) VALUES('alice-market','team-a','alice','Private selection','https://registry.npmjs.org',?)",vec![json!(now())]).await.unwrap();
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
        (
            response.status(),
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap_or(Value::Null),
        )
    }
    async fn task(&self, user: &str, options: Value) -> (StatusCode, Value) {
        self.req(
            Some(user),
            "POST",
            "/api/bot/tasks",
            json!({"request_id":id(),"prompt":"插件测试","options":options}),
        )
        .await
    }
}

#[tokio::test]
async fn plugin_management_requires_browser_owner_and_update_requires_admin() {
    let h = Harness::new().await;
    for (method, path, body) in [
        ("GET", "/api/bot/harness", json!({})),
        ("GET", "/api/bot/plugins/catalog", json!({})),
        (
            "POST",
            "/api/bot/plugins/install",
            json!({"source":"fixture-plugin"}),
        ),
        ("GET", "/api/bot/plugins/fixture-plugin/config", json!({})),
        (
            "POST",
            "/api/bot/plugins/fixture-plugin/config",
            json!({"config":{}}),
        ),
        (
            "POST",
            "/api/bot/plugins/fixture-plugin/enable",
            json!({"enabled":false}),
        ),
        ("DELETE", "/api/bot/plugins/fixture-plugin", json!({})),
        (
            "POST",
            "/api/bot/plugins/marketplaces",
            json!({"source":"https://registry.npmjs.org"}),
        ),
        (
            "DELETE",
            "/api/bot/plugins/marketplaces/alice-market",
            json!({}),
        ),
        ("POST", "/api/bot/harness/update", json!({})),
    ] {
        assert_eq!(
            h.req(None, method, path, body.clone()).await.0,
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
        assert_eq!(
            h.req(Some("ak_fixture"), method, path, body).await.0,
            StatusCode::FORBIDDEN,
            "{method} {path}"
        );
    }
    assert_eq!(
        h.req(Some("alice"), "POST", "/api/bot/harness/update", json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for user in ["bob", "other"] {
        for (method, path, body) in [
            ("GET", "/api/bot/plugins/fixture-plugin/config", json!({})),
            (
                "POST",
                "/api/bot/plugins/fixture-plugin/config",
                json!({"config":{}}),
            ),
            (
                "POST",
                "/api/bot/plugins/fixture-plugin/enable",
                json!({"enabled":false}),
            ),
            ("DELETE", "/api/bot/plugins/fixture-plugin", json!({})),
            (
                "DELETE",
                "/api/bot/plugins/marketplaces/alice-market",
                json!({}),
            ),
            (
                "GET",
                "/api/bot/plugins/catalog?marketplace=alice-market",
                json!({}),
            ),
        ] {
            assert_eq!(
                h.req(Some(user), method, path, body).await.0,
                StatusCode::NOT_FOUND,
                "{user}: {method} {path}"
            );
        }
    }
    assert_eq!(
        h.req(
            Some("alice"),
            "GET",
            &format!("/api/bot/plugins/catalog?q={}", "x".repeat(151)),
            json!({})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/plugins/install",
            json!({"source":"--execute"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/plugins/marketplaces",
            json!({"source":"http://127.0.0.1"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn plugin_configuration_is_encrypted_validated_and_never_returned_or_audited() {
    let h = Harness::new().await;
    let path = "/api/bot/plugins/fixture-plugin/config";
    let (status, value) = h.req(Some("alice"), "GET", path, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["has_config"], false);
    assert_eq!(value["rows"][0]["id"], "fixture-row");
    for config in [
        json!([]),
        json!({"approval":{"policy":"never"}}),
        json!({"fixture-row":"wrong shape"}),
    ] {
        assert_eq!(
            h.req(Some("alice"), "POST", path, json!({"config":config}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let secret = "fixture-private-plugin-secret";
    let (status,value)=h.req(Some("alice"),"POST",path,json!({"config":{"fixture-row":{"token":secret,"base_url":"https://example.test/mcp"}}})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["has_config"], true);
    assert!(!value.to_string().contains(secret));
    let saved = h
        .state
        .db
        .one(
            "SELECT encrypted_config FROM bot_harness_plugins WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!s(&saved, "encrypted_config").is_empty());
    assert!(!s(&saved, "encrypted_config").contains(secret));
    let (_, value) = h.req(Some("alice"), "GET", path, json!({})).await;
    assert_eq!(value["has_config"], true);
    assert!(!value.to_string().contains(secret));
    assert!(value.get("config").is_none());
    let audit = h
        .state
        .db
        .rows(
            "SELECT details FROM audit_events WHERE action='harness.plugin.configure'",
            vec![],
        )
        .await
        .unwrap();
    assert!(!json!(audit).to_string().contains(secret));
    assert_eq!(
        h.req(Some("alice"), "POST", path, json!({"config":{}}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        h.req(Some("alice"), "GET", path, json!({})).await.1["has_config"],
        false
    );
}

#[tokio::test]
async fn cloud_tasks_reject_foreign_disabled_and_incompatible_plugin_selections() {
    let h = Harness::new().await;
    for user in ["bob", "other"] {
        assert_eq!(
            h.task(
                user,
                json!({"runtime":"deepseek-harness","plugin_ids":["fixture-plugin"]})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        h.task(
            "alice",
            json!({"runtime":"pi-agent-core","plugin_ids":["fixture-plugin"]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.task("alice", json!({"runtime":"invented"})).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.task(
            "alice",
            json!({"runtime":"deepseek-harness","local_device_id":"fixture-device"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.task("alice", json!({"plugin_ids":vec!["fixture-plugin";21]}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.task(
            "alice",
            json!({"runtime":"deepseek-harness","plugin_ids":["fixture-plugin","fixture-plugin"]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.task(
            "alice",
            json!({"runtime":"deepseek-harness","plugin_ids":["fixture-plugin"]})
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/plugins/fixture-plugin/enable",
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        h.task("alice", json!({"plugin_ids":["fixture-plugin"]}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "POST",
            "/api/bot/plugins/fixture-plugin/enable",
            json!({"enabled":true})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        h.task("alice", json!({"runtime":"pi-agent-core"})).await.0,
        StatusCode::OK
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "DELETE",
            "/api/bot/plugins/fixture-plugin",
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        h.req(
            Some("alice"),
            "GET",
            "/api/bot/plugins/fixture-plugin/config",
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn native_binary_artifacts_are_bounded_private_and_preserve_exact_bytes() {
    let h = Harness::new().await;
    let (status, task) = h.task("alice", json!({"runtime":"pi-agent-core"})).await;
    assert_eq!(status, StatusCode::OK, "{task}");
    let mut context = Context {
        task_id: task["id"].as_str().unwrap().into(),
        token: "artifact-worker".into(),
        options: Options {
            runtime: Some("pi-agent-core".into()),
            ..Default::default()
        },
        connectors: vec![],
    };
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='running',worker_token=?,lease_until=? WHERE id=?",
            vec![
                json!(context.token),
                json!(now() + 60_000),
                json!(context.task_id),
            ],
        )
        .await
        .unwrap();
    let actor = Actor {
        id: "alice".into(),
        tenant_id: "team-a".into(),
        department_id: String::new(),
        role: "member".into(),
        scopes: None,
        key_id: None,
    };
    let binary = include_bytes!("../../tests/fixtures/diagram.png");
    let args = json!({"name":"native.PNG","content_base64":STANDARD.encode(binary)});
    assert_eq!(
        bot::tool(&h.state, &actor, &context, "write_artifact", args.clone())
            .await
            .unwrap_err()
            .0,
        StatusCode::BAD_REQUEST
    );
    context.options.runtime = Some("deepseek-harness".into());
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET options=? WHERE id=?",
            vec![
                json!(serde_json::to_string(&context.options).unwrap()),
                json!(context.task_id),
            ],
        )
        .await
        .unwrap();
    for invalid in [
        json!({"name":"native.png","content_base64":"invalid!"}),
        json!({"name":"../outside.png","content_base64":STANDARD.encode(binary)}),
        json!({"name":"oversized.pdf","content_base64":STANDARD.encode(vec![0;5_000_001])}),
    ] {
        assert_eq!(
            bot::tool(&h.state, &actor, &context, "write_artifact", invalid)
                .await
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let saved = bot::tool(&h.state, &actor, &context, "write_artifact", args)
        .await
        .unwrap();
    assert_eq!(saved["size"], binary.len());
    let path = format!(
        "/api/bot/artifacts/{}",
        saved["artifact_id"].as_str().unwrap()
    );
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri(&path)
                .header("cookie", "atlas_session=alice")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        binary
    );
    for user in ["bob", "other"] {
        assert_eq!(
            h.req(Some(user), "GET", &path, json!({})).await.0,
            StatusCode::NOT_FOUND
        );
    }
    h.state
        .db
        .exec(
            "UPDATE bot_tasks SET status='cancelled' WHERE id=?",
            vec![json!(context.task_id)],
        )
        .await
        .unwrap();
    assert!(bot::tool(
        &h.state,
        &actor,
        &context,
        "write_artifact",
        json!({"name":"late.png","content_base64":STANDARD.encode(binary)})
    )
    .await
    .is_err());
}
