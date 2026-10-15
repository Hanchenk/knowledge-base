use atlas_server::{
    auth::{self, Actor},
    bot, bot_memory,
    config::Config,
    db::{id, now},
    AppState,
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

struct Fixture {
    state: AppState,
    router: Router,
    _temp: TempDir,
}

#[tokio::test]
async fn personal_settings_support_private_partial_updates_without_resetting_other_switches() {
    let fixture = Fixture::new(None, None).await;
    let path = "/api/bot/memory/settings";
    let initial = json!({"enabled":true,"capture":true,"skill_capture":true});
    assert_eq!(
        fixture.req(Some("alice"), "GET", path, json!({})).await.1,
        initial
    );
    for user in [None, Some("ak_fixture")] {
        assert_eq!(
            fixture
                .req(user, "PUT", path, json!({"skill_capture":false}))
                .await
                .0,
            if user.is_none() {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::FORBIDDEN
            }
        );
    }
    for field in ["tenant_id", "user_id", "role"] {
        let mut body = json!({"skill_capture":false});
        body[field] = json!("foreign");
        assert_eq!(
            fixture.req(Some("alice"), "PUT", path, body).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let (status, settings) = fixture
        .req(Some("alice"), "PUT", path, json!({"skill_capture":false}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        settings,
        json!({"enabled":true,"capture":true,"skill_capture":false})
    );
    let (first, second) = tokio::join!(
        fixture.req(Some("alice"), "PUT", path, json!({"enabled":false})),
        fixture.req(Some("alice"), "PUT", path, json!({"capture":false}))
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second.0, StatusCode::OK);
    let disabled = json!({"enabled":false,"capture":false,"skill_capture":false});
    assert_eq!(
        fixture.req(Some("alice"), "GET", path, json!({})).await.1,
        disabled
    );
    assert_eq!(
        fixture.req(Some("alice"), "PUT", path, json!({})).await.1,
        disabled
    );
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "PUT",
                path,
                json!({"enabled":true,"capture":true})
            )
            .await
            .1,
        json!({"enabled":true,"capture":true,"skill_capture":false})
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/memories", json!({}))
            .await
            .1["settings"]["skill_capture"],
        false
    );
    for user in ["bob", "other"] {
        assert_eq!(
            fixture.req(Some(user), "GET", path, json!({})).await.1,
            initial
        );
    }
}

#[tokio::test]
async fn skill_capture_migration_preserves_legacy_preferences_and_is_restart_safe() {
    let fixture = Fixture::new(None, None).await;
    fixture
        .req(
            Some("alice"),
            "PUT",
            "/api/bot/memory/settings",
            json!({"enabled":false,"capture":false}),
        )
        .await;
    // Recreate a version-16 settings table and upgrade two startup callers together.
    fixture
        .state
        .db
        .exec(
            "ALTER TABLE bot_memory_settings DROP COLUMN skill_capture",
            vec![],
        )
        .await
        .unwrap();
    fixture
        .state
        .db
        .exec("DELETE FROM schema_migrations WHERE version=17", vec![])
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        fixture.state.db.migrate(1536, true),
        fixture.state.db.migrate(1536, true)
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/memory/settings", json!({}))
            .await
            .1,
        json!({"enabled":false,"capture":false,"skill_capture":true})
    );
    fixture
        .req(
            Some("alice"),
            "PUT",
            "/api/bot/memory/settings",
            json!({"skill_capture":false}),
        )
        .await;
    fixture.state.db.migrate(1536, true).await.unwrap();
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/memory/settings", json!({}))
            .await
            .1["skill_capture"],
        false
    );
    let registered = fixture
        .state
        .db
        .rows(
            "SELECT version FROM schema_migrations WHERE version=17",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(registered.len(), 1);
    let columns = fixture
        .state
        .db
        .rows("PRAGMA table_info(bot_memory_settings)", vec![])
        .await
        .unwrap();
    assert_eq!(
        columns
            .iter()
            .filter(|row| row["name"] == "skill_capture")
            .count(),
        1
    );
}

#[tokio::test]
async fn personal_memory_management_is_browser_only_private_and_encrypts_content() {
    let fixture = Fixture::new(None, None).await;
    for (method, path, body) in [
        ("GET", "/api/bot/memories", json!({})),
        (
            "POST",
            "/api/bot/memories",
            json!({"content":"报告使用中文"}),
        ),
        ("GET", "/api/bot/memory/settings", json!({})),
        (
            "PUT",
            "/api/bot/memory/settings",
            json!({"enabled":true,"capture":true}),
        ),
        ("POST", "/api/bot/memories/forget", json!({})),
    ] {
        assert_eq!(
            fixture.req(None, method, path, body.clone()).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            fixture.req(Some("ak_fixture"), method, path, body).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let memory = fixture
        .memory("alice", "月报使用中文，并标注单位与截止日期")
        .await;
    let key = memory["id"].as_str().unwrap();
    assert_eq!(memory["status"], "active");
    let row = fixture
        .state
        .db
        .one("SELECT * FROM bot_memories WHERE id=?", vec![json!(key)])
        .await
        .unwrap()
        .unwrap();
    assert!(!row["encrypted_content"].as_str().unwrap().contains("月报"));
    for user in ["bob", "other"] {
        let own = fixture
            .req(Some(user), "GET", "/api/bot/memories", json!({}))
            .await
            .1;
        assert_eq!(own["items"], json!([]));
        assert_eq!(
            fixture
                .req(
                    Some(user),
                    "PUT",
                    &format!("/api/bot/memories/{key}"),
                    json!({"content":"跨用户覆盖"})
                )
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            fixture
                .req(
                    Some(user),
                    "DELETE",
                    &format!("/api/bot/memories/{key}"),
                    json!({})
                )
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let found = bot_memory::search(
            &fixture.state,
            &fixture.actor(user, if user == "other" { "team-b" } else { "team-a" }),
            "月报",
            5,
        )
        .await
        .unwrap();
        assert_eq!(found["items"], json!([]));
    }
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                "/api/bot/memories",
                json!({"content":"spoof","user_id":"bob"})
            )
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let events = fixture
        .state
        .db
        .rows(
            "SELECT details FROM audit_events WHERE action LIKE 'bot.memory.%'",
            vec![],
        )
        .await
        .unwrap();
    assert!(events
        .iter()
        .all(|event| !event["details"].as_str().unwrap().contains("月报")));
}

#[tokio::test]
async fn harness_proposals_require_review_and_selected_memories_are_bound_to_current_content() {
    let fixture = Fixture::new(None, None).await;
    let task = fixture.task("alice", "team-a", "running", json!([])).await;
    let actor = fixture.actor("alice", "team-a");
    let context = fixture.context(&task);
    let args = json!({"content":"月报使用万元，区分累计与当期","kind":"constraint"});
    let draft = bot_memory::tool_propose(&fixture.state, &actor, &context, args.clone())
        .await
        .unwrap();
    assert_eq!(draft["status"], "pending");
    assert_eq!(
        bot_memory::tool_propose(&fixture.state, &actor, &context, args)
            .await
            .unwrap()["id"],
        draft["id"]
    );
    assert_eq!(
        bot_memory::search(&fixture.state, &actor, "月报", 5)
            .await
            .unwrap()["items"],
        json!([])
    );
    let key = draft["id"].as_str().unwrap();
    let review = format!("/api/bot/memories/{key}/review");
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &review,
                json!({"decision":"approve"})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_tasks SET status='completed' WHERE id=?",
            vec![json!(task)],
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &review,
                json!({"decision":"approve"})
            )
            .await
            .0,
        StatusCode::OK
    );
    let next = fixture.task("alice", "team-a", "running", json!([])).await;
    let next_context = fixture.context(&next);
    let recalled = bot_memory::tool_search(
        &fixture.state,
        &actor,
        &next_context,
        json!({"query":"月报","limit":5}),
    )
    .await
    .unwrap();
    assert_eq!(recalled["items"][0]["id"], draft["id"]);
    bot_memory::validate_task_context(&fixture.state, &actor, &next)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "PUT",
                &format!("/api/bot/memories/{key}"),
                json!({"content":"改用人民币元","kind":"constraint"})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert!(
        bot_memory::validate_task_context(&fixture.state, &actor, &next)
            .await
            .is_err()
    );
    assert!(bot::ensure_running(&fixture.state, &actor, &next_context)
        .await
        .is_err());
}

#[tokio::test]
async fn task_memory_settings_forget_and_tombstones_prevent_model_recreation() {
    let fixture = Fixture::new(None, None).await;
    let task = fixture.task("alice", "team-a", "running", json!([])).await;
    let actor = fixture.actor("alice", "team-a");
    let mut context = fixture.context(&task);
    context.options.memory_enabled = false;
    assert!(bot_memory::tool_propose(
        &fixture.state,
        &actor,
        &context,
        json!({"content":"disabled"})
    )
    .await
    .is_err());
    assert!(bot_memory::tool_search(
        &fixture.state,
        &actor,
        &context,
        json!({"query":"disabled"})
    )
    .await
    .is_err());
    context.options.memory_enabled = true;
    let args = json!({"content":"每次都先检查单位"});
    let draft = bot_memory::tool_propose(&fixture.state, &actor, &context, args.clone())
        .await
        .unwrap();
    let key = draft["id"].as_str().unwrap();
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &format!("/api/bot/memories/{key}/review"),
                json!({"decision":"reject"})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bot_memory::tool_propose(&fixture.state, &actor, &context, args)
            .await
            .unwrap()["id"],
        draft["id"]
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/memories", json!({}))
            .await
            .1["items"],
        json!([])
    );
    fixture.memory("alice", "偏好中文报告").await;
    fixture
        .memory("bob", "Bob keeps his separate preference")
        .await;
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "PUT",
                "/api/bot/memory/settings",
                json!({"enabled":false,"capture":false})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bot_memory::search(&fixture.state, &actor, "中文", 5)
            .await
            .unwrap()["enabled"],
        false
    );
    assert!(bot_memory::tool_propose(
        &fixture.state,
        &actor,
        &context,
        json!({"content":"do not capture"})
    )
    .await
    .is_err());
    assert_eq!(
        fixture
            .req(Some("alice"), "POST", "/api/bot/memories/forget", json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/memories", json!({}))
            .await
            .1["items"],
        json!([])
    );
    assert_eq!(
        fixture
            .req(Some("bob"), "GET", "/api/bot/memories", json!({}))
            .await
            .1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fixture
            .req(Some("alice"), "GET", "/api/bot/memory/settings", json!({}))
            .await
            .1["capture"],
        false
    );
}

#[tokio::test]
async fn revoked_task_sources_block_approval_and_recall_and_pending_chain_content_is_hidden() {
    let fixture = Fixture::new(None, None).await;
    let citation = fixture.document().await;
    let source = fixture
        .task("alice", "team-a", "running", json!([citation]))
        .await;
    let actor = fixture.actor("alice", "team-a");
    let draft = bot_memory::tool_propose(
        &fixture.state,
        &actor,
        &fixture.context(&source),
        json!({"content":"会议约定先核对截止日期","kind":"experience"}),
    )
    .await
    .unwrap();
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_tasks SET status='completed' WHERE id=?",
            vec![json!(source)],
        )
        .await
        .unwrap();
    let review = format!("/api/bot/memories/{}/review", draft["id"].as_str().unwrap());
    fixture
        .state
        .db
        .exec(
            "UPDATE grants SET can_view=0 WHERE id='source-grant'",
            vec![],
        )
        .await
        .unwrap();
    assert_ne!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &review,
                json!({"decision":"approve"})
            )
            .await
            .0,
        StatusCode::OK
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
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &review,
                json!({"decision":"approve"})
            )
            .await
            .0,
        StatusCode::OK
    );
    let child = fixture.task("alice", "team-a", "running", json!([])).await;
    let child_context = fixture.context(&child);
    bot_memory::tool_search(
        &fixture.state,
        &actor,
        &child_context,
        json!({"query":"截止日期"}),
    )
    .await
    .unwrap();
    let pending = bot_memory::tool_propose(
        &fixture.state,
        &actor,
        &child_context,
        json!({"content":"根据历史会议约定，检查截止日期 secret-derived-content"}),
    )
    .await
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
    assert_eq!(
        bot_memory::search(&fixture.state, &actor, "截止日期", 5)
            .await
            .unwrap()["items"],
        json!([])
    );
    assert!(
        bot_memory::validate_task_context(&fixture.state, &actor, &child)
            .await
            .is_err()
    );
    let listed = fixture
        .req(Some("alice"), "GET", "/api/bot/memories", json!({}))
        .await
        .1;
    let pending = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == pending["id"])
        .unwrap();
    assert!(
        !pending["content"]
            .as_str()
            .unwrap()
            .contains("secret-derived-content"),
        "revoked source chain must not reveal derived pending data"
    );
}

#[tokio::test]
async fn approved_task_memory_keeps_original_source_snapshot_after_task_mutation() {
    let fixture = Fixture::new(None, None).await;
    let citation = fixture.document().await;
    let source = fixture
        .task("alice", "team-a", "running", json!([citation]))
        .await;
    let actor = fixture.actor("alice", "team-a");
    let draft = bot_memory::tool_propose(
        &fixture.state,
        &actor,
        &fixture.context(&source),
        json!({"content":"月份汇总先核对原始资料","kind":"experience"}),
    )
    .await
    .unwrap();
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_tasks SET status='completed' WHERE id=?",
            vec![json!(source)],
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                &format!("/api/bot/memories/{}/review", draft["id"].as_str().unwrap()),
                json!({"decision":"approve"})
            )
            .await
            .0,
        StatusCode::OK
    );
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_tasks SET citations='[]',result='source overwritten' WHERE id=?",
            vec![json!(source)],
        )
        .await
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
    assert_eq!(
        bot_memory::search(&fixture.state, &actor, "月份汇总", 5)
            .await
            .unwrap()["items"],
        json!([]),
        "current empty citations cannot erase the original source boundary"
    );
}

#[derive(Clone, Default)]
struct Mock {
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    snapshots: Arc<Mutex<Value>>,
    fail: Arc<AtomicBool>,
    block_write: Arc<AtomicBool>,
    block_read: Arc<AtomicBool>,
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
struct Provider {
    url: String,
    mock: Mock,
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
        async fn write(
            State(mock): State<Mock>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            mock.requests
                .lock()
                .unwrap()
                .push(("write".into(), body.clone()));
            if mock.block_write.swap(false, Ordering::SeqCst) {
                mock.started.notify_one();
                mock.release.notified().await;
            }
            if mock.fail.load(Ordering::SeqCst) {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":50301})));
            }
            *mock.snapshots.lock().unwrap() =
                serde_json::from_str(body["content"].as_str().unwrap()).unwrap();
            (
                StatusCode::OK,
                Json(json!({"code":0,"data":{"updated":true}})),
            )
        }
        async fn read(
            State(mock): State<Mock>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            mock.requests.lock().unwrap().push(("read".into(), body));
            if mock.block_read.swap(false, Ordering::SeqCst) {
                mock.started.notify_one();
                mock.release.notified().await;
            }
            if mock.fail.load(Ordering::SeqCst) {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":50301})));
            }
            let mut snapshot = mock.snapshots.lock().unwrap().clone();
            if let Some(items) = snapshot["items"].as_array_mut() {
                items.push(json!({"id":"fabricated-other-user-id","content":"NEVER EXPOSE FOREIGN DATA","kind":"preference"}));
            }
            (
                StatusCode::OK,
                Json(json!({"code":0,"data":{"content":snapshot.to_string()}})),
            )
        }
        let app = Router::new()
            .route("/v3/core/write", post(write))
            .route("/v3/core/read", post(read))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, mock, handle }
    }
    async fn started(&self) {
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            self.mock.started.notified(),
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn provider_uses_real_curated_snapshot_and_outage_or_fabricated_data_never_expands_recall() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let memory = fixture.memory("alice", "汇报用中文并标注单位").await;
    assert!(bot_memory::tick(&fixture.state).await.unwrap());
    let requests = provider.mock.requests.lock().unwrap().clone();
    let write = &requests.iter().find(|r| r.0 == "write").unwrap().1;
    let snapshot: Value = serde_json::from_str(write["content"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["items"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["items"][0]["id"], memory["id"]);
    assert!(!write["user_id"].as_str().unwrap().contains("alice"));
    let actor = fixture.actor("alice", "team-a");
    let found = bot_memory::search(&fixture.state, &actor, "汇报", 5)
        .await
        .unwrap();
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(found["engine"], "tencentdb-curated");
    assert!(!found.to_string().contains("NEVER EXPOSE FOREIGN DATA"));
    provider.mock.fail.store(true, Ordering::SeqCst);
    let fallback = bot_memory::search(&fixture.state, &actor, "汇报", 5)
        .await
        .unwrap();
    assert_eq!(fallback["items"][0]["id"], memory["id"]);
    assert_eq!(fallback["engine"], "platform-keyword");
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "DELETE",
                &format!("/api/bot/memories/{}", memory["id"].as_str().unwrap()),
                json!({})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bot_memory::search(&fixture.state, &actor, "汇报", 5)
            .await
            .unwrap()["items"],
        json!([])
    );
    let settings = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(settings["revision"].as_i64().unwrap() > settings["synced_revision"].as_i64().unwrap());
    bot_memory::tick(&fixture.state).await.unwrap();
    let settings = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!settings["sync_error"].as_str().unwrap().is_empty());
    provider.mock.fail.store(false, Ordering::SeqCst);
    fixture
        .state
        .db
        .exec("UPDATE bot_memory_settings SET next_attempt_at=0", vec![])
        .await
        .unwrap();
    bot_memory::tick(&fixture.state).await.unwrap();
    assert_eq!(provider.mock.snapshots.lock().unwrap()["items"], json!([]));
}

#[tokio::test]
async fn concurrent_edit_fences_stale_provider_acknowledgement_until_new_snapshot_syncs() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let memory = fixture.memory("alice", "使用万元").await;
    provider.mock.block_write.store(true, Ordering::SeqCst);
    let state = fixture.state.clone();
    let pending = tokio::spawn(async move { bot_memory::tick(&state).await });
    provider.started().await;
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "PUT",
                &format!("/api/bot/memories/{}", memory["id"].as_str().unwrap()),
                json!({"content":"使用人民币元"})
            )
            .await
            .0,
        StatusCode::OK
    );
    provider.mock.release.notify_one();
    pending.await.unwrap().unwrap();
    let prefs = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(prefs["revision"].as_i64().unwrap() > prefs["synced_revision"].as_i64().unwrap());
    assert_eq!(prefs["lease_until"], 0);
    bot_memory::tick(&fixture.state).await.unwrap();
    let prefs = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prefs["revision"], prefs["synced_revision"]);
    assert_eq!(
        provider.mock.snapshots.lock().unwrap()["items"][0]["content"],
        "使用人民币元"
    );
}

#[tokio::test]
async fn concurrent_deletion_during_provider_read_never_returns_stale_memory() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let memory = fixture.memory("alice", "汇报使用中文").await;
    bot_memory::tick(&fixture.state).await.unwrap();
    provider.mock.block_read.store(true, Ordering::SeqCst);
    let state = fixture.state.clone();
    let actor = fixture.actor("alice", "team-a");
    let pending = tokio::spawn(async move { bot_memory::search(&state, &actor, "汇报", 5).await });
    provider.started().await;
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "DELETE",
                &format!("/api/bot/memories/{}", memory["id"].as_str().unwrap()),
                json!({})
            )
            .await
            .0,
        StatusCode::OK
    );
    provider.mock.release.notify_one();
    assert_eq!(pending.await.unwrap().unwrap()["items"], json!([]));
}

#[tokio::test]
async fn provider_drift_is_repaired_without_a_local_edit_and_disabled_owners_are_purged() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let memory = fixture.memory("alice", "汇报使用中文并核对单位").await;
    bot_memory::tick(&fixture.state).await.unwrap();
    let before = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    let revision = before["revision"].as_i64().unwrap();
    assert_eq!(before["synced_revision"], before["revision"]);
    // A late upstream write can overwrite the snapshot after a successful local acknowledgement.
    *provider.mock.snapshots.lock().unwrap() = json!({"version":1,"revision":revision-1,"items":[{"id":memory["id"],"content":"obsolete provider content","kind":"preference"}]});
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_memory_settings SET next_attempt_at=0 WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap();
    bot_memory::tick(&fixture.state).await.unwrap();
    let restored = provider.mock.snapshots.lock().unwrap().clone();
    assert_eq!(restored["revision"], revision);
    assert_eq!(restored["items"][0]["content"], "汇报使用中文并核对单位");
    assert_eq!(restored["items"][0]["id"], memory["id"]);
    let current = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current["revision"], before["revision"],
        "reconciliation must repair drift without requiring a local revision change"
    );
    {
        let requests = provider.mock.requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|r| r.0 == "write").count(), 2);
        assert!(requests.iter().any(|r| r.0 == "read"));
    }
    // Deactivation blocks normal reads but must still allow the worker to erase remote content.
    fixture
        .state
        .db
        .exec("UPDATE users SET active=0 WHERE id='alice'", vec![])
        .await
        .unwrap();
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_memory_settings SET next_attempt_at=0 WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap();
    bot_memory::tick(&fixture.state).await.unwrap();
    let erased = provider.mock.snapshots.lock().unwrap().clone();
    assert_eq!(erased["items"], json!([]));
    assert_eq!(erased["revision"], revision);
    let after = fixture
        .state
        .db
        .one(
            "SELECT * FROM bot_memory_settings WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after["revision"], after["synced_revision"]);
    assert_eq!(after["lease_until"], 0);
    assert!(after["sync_error"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn task_cancellation_during_memory_insert_and_cached_actor_deactivation_cannot_write() {
    let fixture = Fixture::new(None, None).await;
    let task = fixture.task("alice", "team-a", "running", json!([])).await;
    let state = fixture.state.clone();
    let actor = fixture.actor("alice", "team-a");
    let context = fixture.context(&task);
    // WAL readers see the old running task while settings insertion waits for this writer.
    let mut tx = fixture.state.db.pool.begin().await.unwrap();
    fixture
        .state
        .db
        .tx_exec(
            &mut tx,
            "UPDATE bot_tasks SET status='cancelled' WHERE id=?",
            vec![json!(task)],
        )
        .await
        .unwrap();
    let pending = tokio::spawn(async move {
        bot_memory::tool_propose(
            &state,
            &actor,
            &context,
            json!({"content":"cancelled task draft must never persist"}),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    tx.commit().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(fixture
        .state
        .db
        .rows("SELECT id FROM bot_memories", vec![])
        .await
        .unwrap()
        .is_empty());
    let next = fixture.task("alice", "team-a", "running", json!([])).await;
    let actor = fixture.actor("alice", "team-a");
    fixture
        .state
        .db
        .exec("UPDATE users SET active=0 WHERE id='alice'", vec![])
        .await
        .unwrap();
    assert!(bot_memory::tool_propose(
        &fixture.state,
        &actor,
        &fixture.context(&next),
        json!({"content":"deactivated actor must not write"})
    )
    .await
    .is_err());
    assert!(bot_memory::search(&fixture.state, &actor, "anything", 5)
        .await
        .is_err());
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
    async fn memory(&self, user: &str, content: &str) -> Value {
        let (status, value) = self
            .req(
                Some(user),
                "POST",
                "/api/bot/memories",
                json!({"content":content,"kind":"preference"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    fn context(&self, task: &str) -> bot::Context {
        bot::Context {
            task_id: task.into(),
            token: format!("fence-{task}"),
            options: bot::Options::default(),
            connectors: vec![],
        }
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
