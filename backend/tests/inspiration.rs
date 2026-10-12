use atlas_server::{
    auth,
    config::Config,
    db::{id, now},
    AppState,
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

const ROOT: &str = "/api/bot/game/inspiration";
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
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            temporary.path().join("game.db").display()
        );
        if let Ok(url) = std::env::var("ATLAS_TEST_DATABASE_URL") {
            let db = atlas_server::db::Db::connect(&url).await.unwrap();
            let schema = format!("game_test_{}", id().replace('-', ""));
            db.exec(&format!("CREATE SCHEMA {schema}"), vec![])
                .await
                .unwrap();
            db.pool.close().await;
            config.database_url = format!("{url}?options=-csearch_path%3D{schema}%2Cpublic");
        }
        config.qdrant_url = "http://unused.test".into();
        config.storage_path = temporary.path().join("files");
        config.s3_endpoint.clear();
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.seed_demo = false;
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
        let router = atlas_server::router(state.clone());
        Self {
            state,
            router,
            _temporary: temporary,
        }
    }
    async fn member(&self, user: &str, tenant: &str) -> String {
        self.state.db.exec("INSERT INTO users(id,tenant_id,email,name,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)", vec![json!(user),json!(tenant),json!(format!("{user}@example.test")),json!(format!("成员 {user}")),json!("unused"),json!(now())]).await.unwrap();
        let session = format!("game-session-{user}");
        self.state
            .db
            .exec(
                "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
                vec![
                    json!(auth::hash(&session)),
                    json!(user),
                    json!(now() + 3600000),
                ],
            )
            .await
            .unwrap();
        format!("atlas_session={session}")
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Value,
        auth: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("origin", "http://127.0.0.1:5173");
        if let Some(auth) = auth {
            req = if auth.starts_with("Bearer ") {
                req.header("authorization", auth)
            } else {
                req.header("cookie", auth)
            };
        }
        let response = self
            .router
            .clone()
            .oneshot(
                req.body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let data = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
    }
    async fn run(&self, session: &str) -> String {
        let (status, value) = self
            .request("POST", &format!("{ROOT}/runs"), json!({}), Some(session))
            .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value["id"].as_str().unwrap().to_owned()
    }
    async fn age(&self, run: &str) {
        self.state
            .db
            .exec(
                "UPDATE inspiration_runs SET started_at=? WHERE id=?",
                vec![json!(now() - 16000), json!(run)],
            )
            .await
            .unwrap();
    }
    async fn finish(&self, session: &str, run: &str, score: Value) -> (StatusCode, Value) {
        self.request(
            "POST",
            &format!("{ROOT}/runs/{run}/finish"),
            json!({"score":score}),
            Some(session),
        )
        .await
    }
}

#[tokio::test]
async fn game_scores_require_a_browser_session_owned_run_and_valid_finished_game() {
    let h = Harness::new().await;
    let alice = h.member("alice", "team-a").await;
    let bob = h.member("bob", "team-a").await;
    let outsider = h.member("other", "team-b").await;
    for (method, path) in [
        ("GET", format!("{ROOT}/leaderboard")),
        ("POST", format!("{ROOT}/runs")),
    ] {
        assert_eq!(
            h.request(method, &path, json!({}), None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let run = h.run(&alice).await;
    assert_eq!(
        h.finish(&bob, &run, json!(3)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.finish(&outsider, &run, json!(3)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.finish(&alice, &run, json!(3)).await.0,
        StatusCode::BAD_REQUEST
    );
    h.age(&run).await;
    for score in [json!(-1), json!(21), json!(1.5), json!("12")] {
        assert!(h.finish(&alice, &run, score).await.0.is_client_error());
    }
    let (status, result) = h.finish(&alice, &run, json!(0)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["me"]["score"], 0);
    assert_eq!(result["total"], 1);
    let token = "game-api-token";
    h.state.db.exec("INSERT INTO api_keys(id,tenant_id,user_id,name,prefix,secret_hash,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(id()),json!("team-a"),json!("alice"),json!("test"),json!("game"),json!(auth::hash(token)),json!("[]"),json!(now()+3600000),json!(now())]).await.unwrap();
    assert_eq!(
        h.request(
            "GET",
            &format!("{ROOT}/leaderboard"),
            json!({}),
            Some(&format!("Bearer {token}"))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn scores_are_idempotent_concurrent_and_persist_only_the_personal_best() {
    let h = Harness::new().await;
    let alice = h.member("alice", "team-a").await;
    let run = h.run(&alice).await;
    h.age(&run).await;
    let (first, retry) = tokio::join!(
        h.finish(&alice, &run, json!(8)),
        h.finish(&alice, &run, json!(8))
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(retry.0, StatusCode::OK);
    assert_eq!(
        h.finish(&alice, &run, json!(9)).await.0,
        StatusCode::BAD_REQUEST
    );
    let original = h
        .state
        .db
        .one(
            "SELECT achieved_at FROM inspiration_scores WHERE user_id='alice'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    for score in [8, 3, 12] {
        let run = h.run(&alice).await;
        h.age(&run).await;
        let (status, board) = h.finish(&alice, &run, json!(score)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(board["me"]["score"], if score == 12 { 12 } else { 8 });
        if score != 12 {
            let unchanged = h
                .state
                .db
                .one(
                    "SELECT achieved_at FROM inspiration_scores WHERE user_id='alice'",
                    vec![],
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(unchanged, original);
        }
    }
    let reopened = atlas_server::db::Db::connect(&h.state.config.database_url)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .one(
                "SELECT best_score FROM inspiration_scores WHERE user_id='alice'",
                vec![]
            )
            .await
            .unwrap()
            .unwrap()["best_score"],
        12
    );
    assert_eq!(reopened.one("SELECT COUNT(*) AS count FROM inspiration_runs WHERE user_id='alice' AND score IS NOT NULL",vec![]).await.unwrap().unwrap()["count"],4);
}

#[tokio::test]
async fn enterprise_ranking_is_scoped_ties_share_rank_and_own_rank_survives_top_ten() {
    let h = Harness::new().await;
    let alice = h.member("alice", "team-a").await;
    for (i, score) in [20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11]
        .iter()
        .enumerate()
    {
        let user = format!("peer-{i}");
        h.member(&user, "team-a").await;
        h.state
            .db
            .exec(
                "INSERT INTO inspiration_scores VALUES(?,?,?,?)",
                vec![json!("team-a"), json!(user), json!(score), json!(i as i64)],
            )
            .await
            .unwrap();
    }
    let other = h.member("other", "team-b").await;
    let run = h.run(&other).await;
    h.age(&run).await;
    h.finish(&other, &run, json!(20)).await;
    let run = h.run(&alice).await;
    h.age(&run).await;
    let (_, board) = h.finish(&alice, &run, json!(2)).await;
    assert_eq!(board["entries"].as_array().unwrap().len(), 10);
    assert_eq!(board["total"], 12);
    assert_eq!(board["entries"][0]["rank"], 1);
    assert_eq!(board["entries"][1]["rank"], 1);
    assert_eq!(board["entries"][2]["rank"], 3);
    assert_eq!(board["me"]["rank"], 12);
    assert_eq!(board["me"]["is_me"], true);
    assert!(!board.to_string().contains("other"));
    let (_, outsider) = h
        .request(
            "GET",
            &format!("{ROOT}/leaderboard"),
            json!({}),
            Some(&other),
        )
        .await;
    assert_eq!(outsider["total"], 1);
    assert_eq!(outsider["entries"][0]["user_id"], "other");
    h.state
        .db
        .exec("UPDATE users SET active=0 WHERE id='peer-0'", vec![])
        .await
        .unwrap();
    let (_, active) = h
        .request(
            "GET",
            &format!("{ROOT}/leaderboard"),
            json!({}),
            Some(&alice),
        )
        .await;
    assert_eq!(active["total"], 11);
    assert_eq!(active["me"]["rank"], 11);
    assert!(!active.to_string().contains("peer-0"));
}
