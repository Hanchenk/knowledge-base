use super::*;

#[tokio::test]
async fn deleting_primary_during_multi_result_hydration_retains_cleanup_for_unimported_child() {
    let provider = Provider::new().await;
    provider.mock.ready.store(true, Ordering::SeqCst);
    provider.mock.second_result.store(true, Ordering::SeqCst);
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (status, candidate) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":source}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let refresh = fixture.req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}));
    let delete = async {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            provider.mock.second_get_started.notified(),
        )
        .await
        .unwrap();
        let path = format!(
            "/api/bot/skill-candidates/{}",
            candidate["id"].as_str().unwrap()
        );
        assert_eq!(
            fixture
                .req(Some("alice"), "DELETE", &path, json!({}))
                .await
                .0,
            StatusCode::OK
        );
        provider.mock.second_get_release.notify_one();
    };
    let ((status, values), ()) = tokio::join!(refresh, delete);
    assert_eq!(status, StatusCode::OK);
    assert_eq!(values, json!([]));
    let cleanup = fixture
        .state
        .db
        .rows(
            "SELECT * FROM bot_skill_cleanup ORDER BY upstream_skill_id",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(cleanup.len(), 2);
    assert_eq!(cleanup[0]["upstream_skill_id"], "skl-result");
    assert_eq!(cleanup[1]["upstream_skill_id"], "skl-second");
    assert_eq!(cleanup[1]["upstream_task_id"], "archive-1");
    let receipts = fixture
        .state
        .db
        .rows("SELECT * FROM bot_skill_provider_receipts", vec![])
        .await
        .unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0]["registry_id"], receipts[1]["registry_id"]);
    assert!(receipts
        .iter()
        .all(|r| r["extraction_state"] == "acknowledged" && r["upstream_task_id"] == "archive-1"));
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    let requests = provider.mock.requests.lock().unwrap();
    assert!(requests
        .iter()
        .any(|r| r.0 == "delete" && r.1["skill_id"] == "skl-second"));
    assert!(requests
        .iter()
        .filter(|r| r.0 == "delete")
        .all(|r| r.1["skill_id"] == "skl-result" || r.1["skill_id"] == "skl-second"));
}

#[tokio::test]
async fn lost_or_missing_extraction_ack_is_durable_unreviewable_and_never_retried() {
    for missing_ack in [false, true] {
        let provider = Provider::new().await;
        provider.mock.ready.store(true, Ordering::SeqCst);
        provider
            .mock
            .extract_fail_after
            .store(!missing_ack, Ordering::SeqCst);
        provider
            .mock
            .extract_missing_ack
            .store(missing_ack, Ordering::SeqCst);
        let fixture = Fixture::new(Some(&provider.url), None).await;
        let source = fixture
            .task("alice", "team-a", "completed", json!([]))
            .await;
        let (status, error) = fixture
            .req(
                Some("alice"),
                "POST",
                "/api/bot/skill-candidates",
                json!({"task_id":source}),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{error}");
        let receipt = fixture
            .state
            .db
            .one("SELECT * FROM bot_skill_provider_receipts", vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt["extraction_state"], "uncertain");
        assert_eq!(receipt["upstream_task_id"], "");
        assert_eq!(receipt["source_task_id"], source);
        assert!(receipt["submitted_at"].as_i64().unwrap() > 0);
        let key = receipt["id"].as_str().unwrap();
        assert_eq!(receipt["session_id"], format!("skill-{key}"));
        let candidates = fixture
            .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
            .await
            .1;
        assert_eq!(candidates[0]["extraction_state"], "failed");
        assert_eq!(candidates[0]["instructions"], "");
        assert!(candidates[0]["extraction_error"]
            .as_str()
            .unwrap()
            .contains("待核查"));
        assert_eq!(
            fixture
                .req(
                    Some("alice"),
                    "POST",
                    &format!("/api/bot/skill-candidates/{key}/review"),
                    json!({"decision":"approve"})
                )
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(fixture.req(Some("alice"), "PUT", &format!("/api/bot/skill-candidates/{key}"), json!({"instructions":"Cannot silently adopt a result without an archive acknowledgement"})).await.0, StatusCode::CONFLICT);
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
        assert_eq!(
            fixture
                .state
                .db
                .rows("SELECT id FROM bot_skill_provider_receipts", vec![])
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(fixture
            .state
            .db
            .rows("SELECT id FROM bot_skill_cleanup", vec![])
            .await
            .unwrap()
            .is_empty());
        let requests = provider.mock.requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|r| r.0 == "extract").count(), 1);
        assert!(requests
            .iter()
            .all(|r| r.0 != "list" && r.0 != "get" && r.0 != "delete"));
    }
}

#[tokio::test]
async fn acknowledgement_after_source_change_rejection_or_deletion_keeps_exact_archive_cleanup() {
    for change in ["source", "reject", "delete"] {
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
        let mutate = async {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                provider.mock.extract_started.notified(),
            )
            .await
            .unwrap();
            let receipt = fixture
                .state
                .db
                .one("SELECT * FROM bot_skill_provider_receipts", vec![])
                .await
                .unwrap()
                .unwrap();
            assert_eq!(receipt["extraction_state"], "prepared");
            assert!(receipt["submitted_at"].as_i64().unwrap() > 0);
            let key = receipt["id"].as_str().unwrap();
            assert_eq!(
                fixture
                    .state
                    .db
                    .rows("SELECT id FROM bot_skill_candidates", vec![])
                    .await
                    .unwrap()
                    .len(),
                1
            );
            match change {
                "source" => {
                    fixture
                        .state
                        .db
                        .exec(
                            "UPDATE bot_tasks SET result='changed after submission' WHERE id=?",
                            vec![json!(source)],
                        )
                        .await
                        .unwrap();
                }
                "reject" => {
                    assert_eq!(
                        fixture
                            .req(
                                Some("alice"),
                                "POST",
                                &format!("/api/bot/skill-candidates/{key}/review"),
                                json!({"decision":"reject"})
                            )
                            .await
                            .0,
                        StatusCode::OK
                    );
                }
                "delete" => {
                    let (status, value) = fixture
                        .req(
                            Some("alice"),
                            "DELETE",
                            &format!("/api/bot/skill-candidates/{key}"),
                            json!({}),
                        )
                        .await;
                    assert_eq!(status, StatusCode::OK);
                    assert_eq!(value["remote_cleanup_pending"], true);
                }
                _ => unreachable!(),
            }
            provider.mock.extract_release.notify_one();
        };
        let ((status, error), ()) = tokio::join!(submit, mutate);
        assert_eq!(status, StatusCode::CONFLICT, "{change}: {error}");
        let receipt = fixture
            .state
            .db
            .one("SELECT * FROM bot_skill_provider_receipts", vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt["extraction_state"], "acknowledged");
        assert_eq!(receipt["upstream_task_id"], "archive-1");
        assert_ne!(receipt["upstream_task_id"], receipt["id"]);
        let cleanup = fixture
            .state
            .db
            .one("SELECT * FROM bot_skill_cleanup", vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cleanup["id"], receipt["id"]);
        assert_eq!(cleanup["upstream_task_id"], "archive-1");
        assert_eq!(cleanup["status"], "pending");
        if change == "delete" {
            assert!(fixture
                .state
                .db
                .rows("SELECT id FROM bot_skill_candidates", vec![])
                .await
                .unwrap()
                .is_empty());
        }
        provider.mock.ready.store(true, Ordering::SeqCst);
        bot_skill_review::cleanup_tick(&fixture.state)
            .await
            .unwrap();
        let requests = provider.mock.requests.lock().unwrap();
        assert!(requests
            .iter()
            .any(|r| r.0 == "delete" && r.1["skill_id"] == "skl-result"));
        assert!(requests
            .iter()
            .filter(|r| r.0 == "delete")
            .all(|r| r.1["skill_id"] == "skl-result"));
    }
}

#[tokio::test]
async fn interrupted_prepared_submission_is_reconciled_without_a_second_provider_submission() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
        .await;
    let (_, candidate) = fixture
        .req(
            Some("alice"),
            "POST",
            "/api/bot/skill-candidates",
            json!({"task_id":source}),
        )
        .await;
    // Restore the durable state a crash leaves between network send and ack commit.
    fixture.state.db.exec("UPDATE bot_skill_provider_receipts SET extraction_state='prepared',upstream_task_id='',submitted_at=?",vec![json!(now()-600_000)]).await.unwrap();
    fixture
        .state
        .db
        .exec(
            "UPDATE bot_skill_candidates SET upstream_task_id=NULL WHERE id=?",
            vec![candidate["id"].clone()],
        )
        .await
        .unwrap();
    bot_skill_review::cleanup_tick(&fixture.state)
        .await
        .unwrap();
    let receipt = fixture
        .state
        .db
        .one("SELECT * FROM bot_skill_provider_receipts", vec![])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt["extraction_state"], "uncertain");
    let values = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(values[0]["extraction_state"], "failed");
    assert_eq!(
        provider
            .mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.0 == "extract")
            .count(),
        1
    );
    assert!(fixture
        .state
        .db
        .rows("SELECT id FROM bot_skill_cleanup", vec![])
        .await
        .unwrap()
        .is_empty());
}
