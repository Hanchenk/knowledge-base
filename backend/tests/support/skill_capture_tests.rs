use super::*;

#[tokio::test]
async fn disabled_skill_capture_blocks_browser_and_existing_agent_tools_without_provider_work() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let current = fixture.task("alice", "team-a", "running", json!([])).await;
    let actor = fixture.actor("alice", "team-a");
    let context = bot::Context {
        task_id: current.clone(),
        token: format!("fence-{current}"),
        options: bot::Options {
            memory_enabled: false,
            ..Default::default()
        },
        connectors: vec![],
    };
    let settings_path = "/api/bot/memory/settings";
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "PUT",
                settings_path,
                json!({"skill_capture":false})
            )
            .await
            .0,
        StatusCode::OK
    );
    for body in [
        json!({"task_id":source}),
        json!({"task_id":source,"instructions":"Validate the source then verify saved output"}),
    ] {
        assert_eq!(
            fixture
                .req(
                    Some("alice"),
                    "POST",
                    "/api/bot/skill-candidates",
                    body.clone()
                )
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert!(
            bot_skill_review::tool_propose(&fixture.state, &actor, &context, &body)
                .await
                .is_err()
        );
    }
    assert!(fixture
        .state
        .db
        .rows("SELECT id FROM bot_skill_candidates", vec![])
        .await
        .unwrap()
        .is_empty());
    assert!(provider.mock.requests.lock().unwrap().is_empty());
    assert!(provider.registry.data.lock().unwrap().calls.is_empty());
    // This switch is independent of personal memory recall/capture and task opt-out.
    fixture
        .req(
            Some("alice"),
            "PUT",
            settings_path,
            json!({"enabled":false,"capture":false,"skill_capture":true}),
        )
        .await;
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "POST",
                "/api/bot/skill-candidates",
                json!({"task_id":source})
            )
            .await
            .0,
        StatusCode::OK
    );
    let draft=bot_skill_review::tool_propose(&fixture.state,&actor,&context,
        &json!({"task_id":source,"instructions":"Require valid inputs and verify the actual saved output"})).await.unwrap();
    assert_eq!(draft["origin"], "agent");
    assert_eq!(draft["status"], "pending");
}

#[tokio::test]
async fn disabled_skill_capture_keeps_existing_candidates_editable_reviewable_and_usable() {
    let fixture = Fixture::new(None, None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let candidate = fixture.draft(&source).await;
    fixture
        .req(
            Some("alice"),
            "PUT",
            "/api/bot/memory/settings",
            json!({"skill_capture":false}),
        )
        .await;
    let key = candidate["id"].as_str().unwrap();
    let (status, edited) = fixture
        .req(
            Some("alice"),
            "PUT",
            &format!("/api/bot/skill-candidates/{key}"),
            json!({"description":"Reviewed before reuse","version":candidate["version"]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let approved = fixture.approve(&edited).await;
    bot_skill_review::validate_skill(
        &fixture.state,
        &fixture.actor("alice", "team-a"),
        approved["skill_id"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .req(
                Some("alice"),
                "DELETE",
                &format!("/api/bot/skill-candidates/{key}"),
                json!({})
            )
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn disabling_skill_capture_during_submitted_extraction_allows_ack_hydration_review_and_cleanup(
) {
    let provider = Provider::new().await;
    provider.mock.extract_pause.store(true, Ordering::SeqCst);
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let submit = fixture.req(
        Some("alice"),
        "POST",
        "/api/bot/skill-candidates",
        json!({"task_id":source}),
    );
    let disable = async {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            provider.mock.extract_started.notified(),
        )
        .await
        .unwrap();
        assert_eq!(
            fixture
                .req(
                    Some("alice"),
                    "PUT",
                    "/api/bot/memory/settings",
                    json!({"skill_capture":false})
                )
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            fixture
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
        provider.mock.extract_release.notify_one();
    };
    let ((status, queued), ()) = tokio::join!(submit, disable);
    assert_eq!(status, StatusCode::OK, "{queued}");
    provider.mock.ready.store(true, Ordering::SeqCst);
    let ready = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(ready[0]["extraction_state"], "ready");
    let approved = fixture.approve(&ready[0]).await;
    let key = approved["id"].as_str().unwrap();
    let (status, removed) = fixture
        .req(
            Some("alice"),
            "DELETE",
            &format!("/api/bot/skill-candidates/{key}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(removed["remote_cleanup_pending"], true);
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    let requests = provider.mock.requests.lock().unwrap();
    assert_eq!(requests.iter().filter(|r| r.0 == "extract").count(), 1);
    assert!(requests
        .iter()
        .any(|r| r.0 == "delete" && r.1["skill_id"] == "skl-result"));
}
