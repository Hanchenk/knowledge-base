use super::*;
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
    routing::post,
    Form, Router,
};
use http_body_util::BodyExt;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tempfile::TempDir;
use tower::ServiceExt;

#[derive(Default)]
struct Observed {
    registrations: AtomicUsize,
    refreshes: AtomicUsize,
    calls: AtomicUsize,
    denied: AtomicBool,
    oversized: AtomicBool,
    missing_fetch: AtomicBool,
    protocol: Mutex<String>,
    received: Mutex<Vec<Value>>,
}
struct Fixture {
    state: AppState,
    provider: Provider,
    observed: Arc<Observed>,
    _temp: TempDir,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::Config::load().unwrap();
        config.production = false;
        config.allow_insecure_http = true;
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.harness_enabled = false;
        config.public_url = "http://localhost:5173".into();
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("test.db").display()
        );
        config.storage_path = temp.path().join("files");
        config.harness_path = temp.path().join("harness");
        config.s3_bucket.clear();
        config.s3_endpoint.clear();
        config.memory_core_url.clear();
        config.memory_knowledge_url.clear();
        config.ai_api_key.clear();
        config.vision_api_key.clear();
        let state = AppState::new(config).await.unwrap();
        for tenant in ["a", "b"] {
            state
                .db
                .exec(
                    "INSERT INTO tenants(id,slug,name) VALUES(?,?,?)",
                    vec![json!(tenant), json!(tenant), json!(tenant)],
                )
                .await
                .unwrap();
        }
        for (user, tenant) in [("alice", "a"), ("bob", "a"), ("other", "b")] {
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
        let observed = Arc::new(Observed::default());
        *observed.protocol.lock().unwrap() = "2025-06-18".into();
        let app=Router::new()
            .route("/register",post({let o=observed.clone(); move |Json(body):Json<Value>| {let o=o.clone(); async move {
                o.registrations.fetch_add(1,Ordering::SeqCst);
                assert_eq!(body["client_name"],"知小汇"); assert_eq!(body["token_endpoint_auth_method"],"none");
                assert_eq!(body["grant_types"],json!(["authorization_code","refresh_token"]));
                assert_eq!(body["redirect_uris"],json!([format!("http://localhost:5173{CALLBACK}")]));
                tokio::time::sleep(Duration::from_millis(80)).await;
                Json(json!({"client_id":"fixture-public-client","token_endpoint_auth_method":"none"}))
            }}}))
            .route("/token",post({let o=observed.clone(); move |Form(body):Form<HashMap<String,String>>| {let o=o.clone(); async move {
                assert_eq!(body.get("client_id").map(String::as_str),Some("fixture-public-client"));
                assert!(!body.contains_key("client_secret")); assert_eq!(body.get("resource").map(String::as_str),Some(RESOURCE));
                let refresh=body.get("grant_type").is_some_and(|v|v=="refresh_token");
                if refresh { o.refreshes.fetch_add(1,Ordering::SeqCst); tokio::time::sleep(Duration::from_millis(100)).await; }
                else { assert_eq!(body.get("code_verifier").unwrap().len(),64); assert_eq!(body.get("code").map(String::as_str),Some("fixture-code")); }
                Json(json!({"code":0,"access_token":if refresh{"fixture-access-rotated"}else{"fixture-access"},
                    "refresh_token":if refresh{"fixture-refresh-rotated"}else{"fixture-refresh"},
                    "token_type":"Bearer","expires_in":3600,"refresh_token_expires_in":2592000,"scope":SCOPES}))
            }}}))
            .route("/mcp",post({let o=observed.clone(); move |headers:HeaderMap,Json(body):Json<Value>| {let o=o.clone(); async move {
                if o.denied.load(Ordering::SeqCst) { return (StatusCode::UNAUTHORIZED,Json(json!({"secret":"do-not-expose-provider-body"}))).into_response(); }
                assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer fixture-access"));
                let method=body["method"].as_str().unwrap();
                if method!="initialize" {
                    assert_eq!(headers["mcp-protocol-version"].to_str().unwrap(),o.protocol.lock().unwrap().as_str());
                    assert_eq!(headers["mcp-session-id"],"fixture-session");
                }
                if method=="notifications/initialized" { return StatusCode::ACCEPTED.into_response(); }
                let result=match method {
                    "initialize"=>json!({"protocolVersion":o.protocol.lock().unwrap().clone(),"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}),
                    "tools/list"=> {
                        let mut tools=vec![read_tool("search-doc"),read_tool("get-user"),read_tool("list-docs")];
                        if !o.missing_fetch.load(Ordering::SeqCst) { tools.push(read_tool("fetch-doc")); }
                        tools.push(json!({"name":"create-doc","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}));
                        json!({"tools":tools})
                    }
                    "tools/call"=> {
                        o.calls.fetch_add(1,Ordering::SeqCst); o.received.lock().unwrap().push(body["params"].clone());
                        json!({"content":[{"type":"text","text":if o.oversized.load(Ordering::SeqCst){"x".repeat(MAX_RESPONSE+1)}else{"fixture document".into()}}]})
                    }
                    _=>panic!("unexpected fixture method"),
                };
                let payload=json!({"jsonrpc":"2.0","id":body["id"],"result":result});
                if method=="initialize" {
                    ([("mcp-session-id","fixture-session")],Json(payload)).into_response()
                } else {
                    ([("content-type","text/event-stream")],format!(": heartbeat\n\nevent: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{{}}}}\n\nevent: message\ndata: {payload}\n\n")).into_response()
                }
            }}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = Provider {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap(),
            registration: format!("{base}/register"),
            token: format!("{base}/token"),
            resource: format!("{base}/mcp"),
        };
        Self {
            state,
            provider,
            observed,
            _temp: temp,
            server,
        }
    }
    fn actor(&self, user: &str) -> Actor {
        Actor {
            id: user.into(),
            tenant_id: if user == "other" { "b" } else { "a" }.into(),
            department_id: String::new(),
            role: "member".into(),
            scopes: None,
            key_id: None,
        }
    }
    fn jar(&self, user: &str) -> CookieJar {
        CookieJar::new().add(Cookie::new("atlas_session", user.to_owned()))
    }
    async fn start(&self, user: &str) -> (CookieJar, String) {
        let (jar, Json(body)) = authorize_with(
            &self.state,
            &self.actor(user),
            self.jar(user),
            &self.provider,
        )
        .await
        .unwrap();
        let url = reqwest::Url::parse(body["authorization_url"].as_str().unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("accounts.feishu.cn"));
        let params = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            params.get("code_challenge_method").map(|v| v.as_ref()),
            Some("S256")
        );
        assert_eq!(params.get("scope").map(|v| v.as_ref()), Some(SCOPES));
        let secret = params.get("state").unwrap().to_string();
        let row = self
            .state
            .db
            .one(
                "SELECT encrypted_verifier FROM bot_feishu_oauth_states WHERE id=?",
                vec![json!(auth::hash(&secret))],
            )
            .await
            .unwrap()
            .unwrap();
        let verifier: String = models::open(
            &self.state,
            &self.actor(user).tenant_id,
            s(&row, "encrypted_verifier"),
        )
        .unwrap();
        assert_eq!(
            params["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
        (jar, secret)
    }
    async fn connect(&self, user: &str) -> String {
        let (jar, secret) = self.start(user).await;
        let (_, redirect) = callback_with(
            &self.state,
            &self.actor(user),
            jar,
            Callback {
                state: secret,
                code: Some("fixture-code".into()),
                error: None,
            },
            &self.provider,
        )
        .await
        .unwrap();
        assert_eq!(
            redirect.into_response().headers()["location"],
            "/app?view=bot&feishu=connected"
        );
        self.state
            .db
            .one(
                "SELECT connector_id FROM bot_feishu_accounts WHERE user_id=?",
                vec![json!(user)],
            )
            .await
            .unwrap()
            .unwrap()["connector_id"]
            .as_str()
            .unwrap()
            .into()
    }
}
fn read_tool(name: &str) -> Value {
    // Known official read operations remain reads even with old erroneous hints.
    json!({"name":name,"description":"fixture read tool","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"additionalProperties":false},
        "annotations":{"readOnlyHint":false,"destructiveHint":true}})
}

#[tokio::test]
async fn oauth_register_pkce_connect_reconnect_encrypts_and_keeps_owner_metadata_private() {
    let f = Fixture::new().await;
    let key = f.connect("alice").await;
    assert_eq!(key, f.connect("alice").await);
    assert_eq!(f.observed.registrations.load(Ordering::SeqCst), 1);
    let row = account(&f.state, &f.actor("alice"), &key).await.unwrap();
    assert!(!s(&row, "encrypted_tokens").contains("fixture-access"));
    assert!(!s(&row, "encrypted_tokens").contains("fixture-refresh"));
    let Json(public) = crate::bot::connectors(State(f.state.clone()), f.actor("alice"))
        .await
        .unwrap();
    assert_eq!(public[0]["provider"], "feishu");
    assert_eq!(public[0]["status"], "connected");
    assert!(!public.to_string().contains("fixture-"));
    let Json(status) = status(State(f.state.clone()), f.actor("alice"))
        .await
        .unwrap();
    assert_eq!(status["connected"], true);
    assert!(account(&f.state, &f.actor("bob"), &key).await.is_err());
    assert!(account(&f.state, &f.actor("other"), &key).await.is_err());
    assert!(models::open::<Tokens>(&f.state, "b", s(&row, "encrypted_tokens")).is_err());
    let catalog = context_catalog(&f.state, &f.actor("alice"), &key)
        .await
        .unwrap();
    assert!(catalog
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["name"] == "fetch-doc"));
    assert!(!catalog.to_string().contains("create-doc"));
    assert!(!catalog.to_string().contains("fixture-access"));
}

#[tokio::test]
async fn oauth_state_is_session_tenant_cookie_bound_expiring_and_single_use() {
    let f = Fixture::new().await;
    let (jar, secret) = f.start("alice").await;
    let request = || Callback {
        state: secret.clone(),
        code: None,
        error: Some("access_denied".into()),
    };
    for user in ["bob", "other"] {
        let badjar = f.jar(user).add(jar.get(COOKIE).unwrap().clone());
        assert!(
            callback_with(&f.state, &f.actor(user), badjar, request(), &f.provider)
                .await
                .is_err()
        );
    }
    let badjar = f.jar("alice").add(Cookie::new(COOKIE, "wrong-browser"));
    assert!(
        callback_with(&f.state, &f.actor("alice"), badjar, request(), &f.provider)
            .await
            .is_err()
    );
    f.state
        .db
        .exec(
            "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,'alice',?)",
            vec![json!(auth::hash("new-session")), json!(now() + 10000)],
        )
        .await
        .unwrap();
    let changed = CookieJar::new()
        .add(Cookie::new("atlas_session", "new-session"))
        .add(jar.get(COOKIE).unwrap().clone());
    assert!(
        callback_with(&f.state, &f.actor("alice"), changed, request(), &f.provider)
            .await
            .is_err()
    );
    let (_, redirect) = callback_with(
        &f.state,
        &f.actor("alice"),
        jar.clone(),
        request(),
        &f.provider,
    )
    .await
    .unwrap();
    assert_eq!(
        redirect.into_response().headers()["location"],
        "/app?view=bot&feishu=cancelled"
    );
    assert!(
        callback_with(&f.state, &f.actor("alice"), jar, request(), &f.provider)
            .await
            .is_err()
    );
    let (jar, secret) = f.start("alice").await;
    f.state
        .db
        .exec(
            "UPDATE bot_feishu_oauth_states SET expires_at=? WHERE id=?",
            vec![json!(now() - 1), json!(auth::hash(&secret))],
        )
        .await
        .unwrap();
    assert!(callback_with(
        &f.state,
        &f.actor("alice"),
        jar,
        Callback {
            state: secret,
            code: None,
            error: Some("access_denied".into())
        },
        &f.provider
    )
    .await
    .is_err());
}

#[tokio::test]
async fn dynamic_registration_and_rotating_refresh_are_single_writer_across_concurrent_requests() {
    let f = Fixture::new().await;
    let actor = f.actor("alice");
    let redirect = redirect_uri(&f.state).unwrap();
    let (a, b) = tokio::join!(
        registered_client(&f.state, &actor, &f.provider, &redirect),
        registered_client(&f.state, &actor, &f.provider, &redirect)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(f.observed.registrations.load(Ordering::SeqCst), 1);
    let key = f.connect("alice").await;
    f.state
        .db
        .exec(
            "UPDATE bot_feishu_accounts SET access_expires_at=? WHERE connector_id=?",
            vec![json!(now() - 1), json!(key)],
        )
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        access_token(&f.state, &actor, &key, &f.provider),
        access_token(&f.state, &actor, &key, &f.provider)
    );
    let (a, av) = a.unwrap();
    let (b, bv) = b.unwrap();
    assert_eq!(a.access_token, "fixture-access-rotated");
    assert_eq!(a.access_token, b.access_token);
    assert_eq!(av, bv);
    assert_eq!(f.observed.refreshes.load(Ordering::SeqCst), 1);
    let row = account(&f.state, &actor, &key).await.unwrap();
    let tokens: Tokens = models::open(&f.state, "a", s(&row, "encrypted_tokens")).unwrap();
    assert_eq!(tokens.refresh_token, "fixture-refresh-rotated");
    disconnect(&f.state, &actor, &key).await.unwrap();
    assert!(access_token(&f.state, &actor, &key, &f.provider)
        .await
        .is_err());
    let row = f
        .state
        .db
        .one(
            "SELECT encrypted_tokens FROM bot_feishu_accounts WHERE connector_id=?",
            vec![json!(key)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "encrypted_tokens"), "");
}

#[tokio::test]
async fn mcp_read_dispatch_uses_actual_schemas_scopes_and_rejects_write_or_unknown_arguments() {
    let f = Fixture::new().await;
    let key = f.connect("alice").await;
    let actor = f.actor("alice");
    let input = json!({"tool":"fetch-doc","arguments":{"query":"test"}});
    let value = call_with(&f.state, &actor, &key, &input, &f.provider)
        .await
        .unwrap();
    assert_eq!(value["content"][0]["text"], "fixture document");
    assert_eq!(f.observed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.observed.received.lock().unwrap()[0],
        json!({"name":"fetch-doc","arguments":{"query":"test"}})
    );
    for input in [
        json!({"tool":"create-doc","arguments":{}}),
        json!({"tool":"fetch-doc","arguments":{},"url":"http://localhost"}),
        json!({"tool":"fetch-doc","arguments":{"query":1}}),
        json!({"tool":"fetch-doc","arguments":{"url":"http://localhost"}}),
    ] {
        assert!(call_with(&f.state, &actor, &key, &input, &f.provider)
            .await
            .is_err());
    }
    assert_eq!(f.observed.calls.load(Ordering::SeqCst), 1);
    assert!(!scope_allows("mcp-tool:docs:search-doc", "fetch-doc"));
    assert!(!scope_allows(SCOPES, "create-doc"));
    assert!(
        call_with(&f.state, &f.actor("bob"), &key, &input, &f.provider)
            .await
            .is_err()
    );
    let task = id();
    f.state.db.exec("INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,worker_token,lease_until,created_at,updated_at) VALUES(?,'a','alice',?,'fixture','fixture','running','{}','lease',?,?,?)",vec![json!(task),json!(id()),json!(now()+60000),json!(now()),json!(now())]).await.unwrap();
    let context = crate::bot::Context {
        task_id: task,
        token: "lease".into(),
        options: crate::bot::Options::default(),
        connectors: vec![],
    };
    assert!(crate::bot::tool(
        &f.state,
        &actor,
        &context,
        "connector_call",
        json!({"connector_id":key,"input":input})
    )
    .await
    .is_err());
}

#[tokio::test]
async fn protocol_versions_sse_progress_errors_and_response_limits_are_checked() {
    let f = Fixture::new().await;
    let key = f.connect("alice").await;
    let actor = f.actor("alice");
    for protocol in ["2024-11-05", "2025-03-26", "2025-06-18"] {
        *f.observed.protocol.lock().unwrap() = protocol.into();
        assert!(catalog_with(&f.state, &actor, &key, &f.provider)
            .await
            .is_ok());
    }
    *f.observed.protocol.lock().unwrap() = "unknown".into();
    assert!(catalog_with(&f.state, &actor, &key, &f.provider)
        .await
        .is_err());
    *f.observed.protocol.lock().unwrap() = "2025-06-18".into();
    f.observed.oversized.store(true, Ordering::SeqCst);
    let error = call_with(
        &f.state,
        &actor,
        &key,
        &json!({"tool":"fetch-doc","arguments":{}}),
        &f.provider,
    )
    .await
    .err()
    .unwrap();
    assert!(error.1.contains("256 KB"));
    assert!(!error.1.contains("fixture-access"));
    f.observed.oversized.store(false, Ordering::SeqCst);
    f.observed.denied.store(true, Ordering::SeqCst);
    let error = catalog_with(&f.state, &actor, &key, &f.provider)
        .await
        .err()
        .unwrap();
    assert!(!error.1.contains("do-not-expose-provider-body"));
    assert!(reconnect(
        &f.state,
        &account(&f.state, &actor, &key).await.unwrap()
    ));
    let bytes=b": ping\n\ndata: {\"id\":\"other\",\"result\":{}}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"expected\",\"result\":{}}\n\n";
    assert_eq!(
        sse_response(bytes, false, Some("expected"))
            .unwrap()
            .unwrap()["id"],
        "expected"
    );
    assert!(
        sse_response(b"data: {\"id\":\"expected\"}", false, Some("expected"))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn missing_required_read_tool_cannot_claim_connection_and_routes_require_browser_origin() {
    let f = Fixture::new().await;
    f.observed.missing_fetch.store(true, Ordering::SeqCst);
    let (jar, secret) = f.start("alice").await;
    let (_, redirect) = callback_with(
        &f.state,
        &f.actor("alice"),
        jar,
        Callback {
            state: secret,
            code: Some("fixture-code".into()),
            error: None,
        },
        &f.provider,
    )
    .await
    .unwrap();
    assert_eq!(
        redirect.into_response().headers()["location"],
        "/app?view=bot&feishu=error"
    );
    let Json(initial_status) = status(State(f.state.clone()), f.actor("alice"))
        .await
        .unwrap();
    assert_eq!(initial_status["connected"], false);
    let router = crate::router(f.state.clone());
    for (method, path, cookie, origin, wanted) in [
        (
            "GET",
            "/api/bot/connectors/feishu/status",
            false,
            false,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "POST",
            "/api/bot/connectors/feishu/authorize",
            true,
            false,
            StatusCode::FORBIDDEN,
        ),
        (
            "GET",
            "/api/bot/connectors/feishu/callback?state=bad&code=private-code",
            true,
            false,
            StatusCode::FOUND,
        ),
    ] {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if cookie {
            builder = builder.header("cookie", "atlas_session=alice");
        }
        if origin {
            builder = builder.header("origin", "http://localhost:5173");
        }
        let response = router
            .clone()
            .oneshot(builder.body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), wanted);
        assert_eq!(response.headers()["cache-control"], "no-store");
        if path.starts_with(CALLBACK) {
            assert_eq!(response.headers()["referrer-policy"], "no-referrer");
            assert_eq!(response.headers()["location"], "/app?view=bot&feishu=error");
        }
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&body).contains("private-code"));
    }

    // Even with an active application login, an expired OAuth state or missing
    // state cookie must return to the draft instead of stranding the browser.
    let (jar, secret) = f.start("alice").await;
    f.state
        .db
        .exec(
            "UPDATE bot_feishu_oauth_states SET expires_at=? WHERE id=?",
            vec![json!(now() - 1), json!(auth::hash(&secret))],
        )
        .await
        .unwrap();
    for cookie in [
        format!(
            "atlas_session=alice; {COOKIE}={}",
            jar.get(COOKIE).unwrap().value()
        ),
        "atlas_session=alice".into(),
    ] {
        let had_state_cookie = cookie.contains(&format!("{COOKIE}="));
        let response = crate::router(f.state.clone())
            .oneshot(
                Request::builder()
                    .uri(format!("{CALLBACK}?state={secret}&code=private-code"))
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.headers()["location"], "/app?view=bot&feishu=error");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        if had_state_cookie {
            assert!(response.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .contains("Max-Age=0"));
        }
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&body).contains("private-code"));
    }
    let Json(status) = status(State(f.state.clone()), f.actor("alice"))
        .await
        .unwrap();
    assert_eq!(status["connected"], false);
}

#[tokio::test]
async fn reconnect_required_selection_is_rejected_and_claimed_task_fails_without_waiting_for_lease()
{
    let f = Fixture::new().await;
    let key = f.connect("alice").await;
    f.state
        .db
        .exec(
            "UPDATE bot_feishu_accounts SET needs_reconnect=1 WHERE connector_id=?",
            vec![json!(key)],
        )
        .await
        .unwrap();
    let router = crate::router(f.state.clone());
    let request = Request::builder()
        .method("POST")
        .uri("/api/bot/tasks")
        .header("content-type", "application/json")
        .header("cookie", "atlas_session=alice")
        .header("origin", "http://localhost:5173")
        .body(Body::from(
            json!({"request_id":id(),"prompt":"Read Feishu","options":{"connector_ids":[key]}})
                .to_string(),
        ))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let task = id();
    f.state.db.exec("INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,created_at,updated_at) VALUES(?,'a','alice',?,'fixture','fixture','queued',?,?,?)",vec![json!(task),json!(id()),json!(json!({"connector_ids":[key]}).to_string()),json!(now()),json!(now())]).await.unwrap();
    let calls_before = f.observed.calls.load(Ordering::SeqCst);
    assert!(crate::bot::run_one(&f.state).await.unwrap());
    let row = f
        .state
        .db
        .one(
            "SELECT status,worker_token,lease_until,error FROM bot_tasks WHERE id=?",
            vec![json!(task)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "failed");
    assert!(row["worker_token"].is_null());
    assert!(row["lease_until"].is_null());
    assert_eq!(f.observed.calls.load(Ordering::SeqCst), calls_before);
    assert!(!s(&row, "error").contains("fixture-access"));
    assert!(s(&row, "error").contains("飞书"));

    // A connector can be disconnected after submission and before the worker
    // claims it. The worker must fail rather than silently omit selected data.
    let task = id();
    f.state.db.exec("INSERT INTO bot_tasks(id,tenant_id,user_id,request_id,prompt,title,status,options,created_at,updated_at) VALUES(?,'a','alice',?,'fixture','fixture','queued',?,?,?)",vec![json!(task),json!(id()),json!(json!({"connector_ids":[key]}).to_string()),json!(now()),json!(now())]).await.unwrap();
    disconnect(&f.state, &f.actor("alice"), &key).await.unwrap();
    assert!(crate::bot::run_one(&f.state).await.unwrap());
    let row = f
        .state
        .db
        .one(
            "SELECT status,worker_token,lease_until,error FROM bot_tasks WHERE id=?",
            vec![json!(task)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&row, "status"), "failed");
    assert!(row["worker_token"].is_null());
    assert!(row["lease_until"].is_null());
    assert_eq!(f.observed.calls.load(Ordering::SeqCst), calls_before);
    assert!(!s(&row, "error").contains("fixture-access"));
    assert_eq!(s(&row, "error"), AppError::missing().1);
}

#[tokio::test]
async fn expired_ambiguous_refresh_is_never_replayed_and_migration_is_restart_safe() {
    let f = Fixture::new().await;
    let key = f.connect("alice").await;
    f.state.db.exec("UPDATE bot_feishu_accounts SET access_expires_at=?,refresh_lease='crashed-request',refresh_lease_until=? WHERE connector_id=?",vec![json!(now()-1),json!(now()-1),json!(key)]).await.unwrap();
    assert!(access_token(&f.state, &f.actor("alice"), &key, &f.provider)
        .await
        .is_err());
    assert_eq!(f.observed.refreshes.load(Ordering::SeqCst), 0);
    assert!(reconnect(
        &f.state,
        &account(&f.state, &f.actor("alice"), &key).await.unwrap()
    ));
    f.state
        .db
        .migrate(f.state.config.embedding_dimensions, true)
        .await
        .unwrap();
    let row = account(&f.state, &f.actor("alice"), &key).await.unwrap();
    assert_eq!(n(&row, "needs_reconnect"), 1);
    assert!(!s(&row, "encrypted_tokens").contains("fixture-access"));
    let row = f
        .state
        .db
        .one(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=18",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n(&row, "count"), 1);
}
