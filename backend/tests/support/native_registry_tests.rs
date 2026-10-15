use super::*;

#[tokio::test]
async fn missing_native_skill_owner_fields_cannot_hydrate_a_candidate() {
    let provider = Provider::new().await;
    provider.mock.ready.store(true, Ordering::SeqCst);
    provider
        .mock
        .detail_missing_owner
        .store(true, Ordering::SeqCst);
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let source = fixture
        .task("alice", "team-a", "completed", json!([]))
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
    let value = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(value[0]["extraction_state"], "queued");
    assert_eq!(value[0]["instructions"], "");
    provider
        .mock
        .detail_missing_owner
        .store(false, Ordering::SeqCst);
    let value = fixture
        .req(Some("alice"), "GET", "/api/bot/skill-candidates", json!({}))
        .await
        .1;
    assert_eq!(value[0]["extraction_state"], "ready");
}

#[tokio::test]
async fn native_registry_serializes_creation_and_keeps_same_tenant_owners_private() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let alice = fixture.actor("alice", "team-a");
    let (first, second) = tokio::join!(
        core_skill_registry::ensure(&fixture.state, &alice),
        core_skill_registry::ensure(&fixture.state, &alice)
    );
    let first = first.unwrap();
    assert_eq!(first, second.unwrap());
    let bob = core_skill_registry::ensure(&fixture.state, &fixture.actor("bob", "team-a"))
        .await
        .unwrap();
    for field in ["user_id", "team_id", "agent_id"] {
        assert_ne!(first[field], bob[field]);
    }
    {
        let data = provider.registry.data.lock().unwrap();
        assert_eq!(data.users.len(), 2);
        assert_eq!(data.teams.len(), 2);
        assert_eq!(data.agents.len(), 2);
        assert!(data.agents.iter().all(|v| v["visibility"] == "private"));
        assert_eq!(
            data.calls
                .iter()
                .filter(|v| v.as_str() == "/v3/meta/user/create-with-key")
                .count(),
            2
        );
    }
    memory_provider::post_core(&fixture.state, &alice, "/v3/core/read", json!({}))
        .await
        .unwrap();
    let requests = provider.mock.requests.lock().unwrap();
    assert_eq!(
        requests.iter().find(|r| r.0 == "core").unwrap().1["agent_id"],
        memory_provider::identity(&alice, false)["agent_id"]
    );
    assert_ne!(
        memory_provider::identity(&alice, false)["agent_id"],
        first["agent_id"]
    );
}

#[tokio::test]
async fn lost_native_user_team_and_agent_create_responses_recover_without_duplicate_entities() {
    for path in [
        "/v3/meta/user/create-with-key",
        "/v3/meta/team/create",
        "/v3/meta/agent/create",
    ] {
        let provider = Provider::new().await;
        let fixture = Fixture::new(Some(&provider.url), None).await;
        let actor = fixture.actor("alice", "team-a");
        provider.registry.data.lock().unwrap().fail_after = Some(path.into());
        let source = fixture
            .task("alice", "team-a", "completed", json!([]))
            .await;
        let (status, _) = fixture
            .req(
                Some("alice"),
                "POST",
                "/api/bot/skill-candidates",
                json!({"task_id":source}),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(fixture
            .state
            .db
            .rows("SELECT id FROM bot_skill_candidates", vec![])
            .await
            .unwrap()
            .is_empty());
        assert!(provider
            .mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.0 != "extract"));
        let value = core_skill_registry::ensure(&fixture.state, &actor)
            .await
            .unwrap();
        assert!(value["agent_id"].is_string());
        {
            let data = provider.registry.data.lock().unwrap();
            assert_eq!(data.users.len(), 1);
            assert_eq!(data.teams.len(), 1);
            assert_eq!(data.agents.len(), 1);
            assert_eq!(data.calls.iter().filter(|p| p.as_str() == path).count(), 1);
        }
        let row = fixture
            .state
            .db
            .one(
                "SELECT ready,lease_token,lease_until FROM core_skill_registry",
                vec![],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row["ready"], 1);
        assert_eq!(row["lease_token"], "");
        assert_eq!(row["lease_until"], 0);
    }
}

#[tokio::test]
async fn native_registry_rejects_catalog_owner_visibility_status_and_marker_drift() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let actor = fixture.actor("alice", "team-a");
    core_skill_registry::ensure(&fixture.state, &actor)
        .await
        .unwrap();
    let agent = provider.registry.data.lock().unwrap().agents[0].clone();
    for field in [
        "owner_user_id",
        "team_id",
        "visibility",
        "status",
        "metadata_json",
    ] {
        provider.registry.data.lock().unwrap().agents[0][field] = json!("foreign");
        assert!(memory_provider::post_core(
            &fixture.state,
            &actor,
            "/v3/skill/extract",
            json!({"messages":[]})
        )
        .await
        .is_err());
        provider.registry.data.lock().unwrap().agents[0] = agent.clone();
    }
    let team = provider.registry.data.lock().unwrap().teams[0].clone();
    for field in ["owner_user_id", "status", "metadata_json"] {
        provider.registry.data.lock().unwrap().teams[0][field] = json!("foreign");
        assert!(core_skill_registry::ensure(&fixture.state, &actor)
            .await
            .is_err());
        provider.registry.data.lock().unwrap().teams[0] = team.clone();
    }
    provider
        .registry
        .data
        .lock()
        .unwrap()
        .users
        .values_mut()
        .next()
        .unwrap()["status"] = json!("inactive");
    assert!(core_skill_registry::ensure(&fixture.state, &actor)
        .await
        .is_err());
    assert!(provider.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn native_owner_credentials_are_encrypted_and_bound_to_registry_owner() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let alice = fixture.actor("alice", "team-a");
    let bob = fixture.actor("bob", "team-a");
    core_skill_registry::ensure(&fixture.state, &alice)
        .await
        .unwrap();
    core_skill_registry::ensure(&fixture.state, &bob)
        .await
        .unwrap();
    let rows = fixture
        .state
        .db
        .rows("SELECT * FROM core_skill_registry ORDER BY user_id", vec![])
        .await
        .unwrap();
    for row in &rows {
        let ciphertext = row["encrypted_owner_key"].as_str().unwrap();
        assert!(provider
            .registry
            .data
            .lock()
            .unwrap()
            .users
            .keys()
            .all(|key| !ciphertext.contains(key)));
    }
    fixture
        .state
        .db
        .exec(
            "UPDATE core_skill_registry SET encrypted_owner_key=? WHERE user_id='bob'",
            vec![rows[0]["encrypted_owner_key"].clone()],
        )
        .await
        .unwrap();
    let before = provider.registry.data.lock().unwrap().calls.len();
    assert!(core_skill_registry::ensure(&fixture.state, &bob)
        .await
        .is_err());
    assert_eq!(provider.registry.data.lock().unwrap().calls.len(), before);
}

#[tokio::test]
async fn provider_namespace_changes_cannot_reuse_old_skill_receipts_or_cleanup() {
    let provider = Provider::new().await;
    let fixture = Fixture::new(Some(&provider.url), None).await;
    let actor = fixture.actor("alice", "team-a");
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
    let receipt = candidate["id"].as_str().unwrap();
    core_skill_registry::receipt_identity(&fixture.state, &actor, receipt)
        .await
        .unwrap();
    let path = format!("/api/bot/skill-candidates/{receipt}/review");
    assert_eq!(
        fixture
            .req(Some("alice"), "POST", &path, json!({"decision":"reject"}))
            .await
            .0,
        StatusCode::OK
    );
    let mut changed = fixture.state.clone();
    Arc::make_mut(&mut changed.config).memory_service_id = "different-native-instance".into();
    assert_ne!(
        core_skill_registry::namespace(&changed),
        core_skill_registry::namespace(&fixture.state)
    );
    assert!(
        core_skill_registry::receipt_identity(&changed, &actor, receipt)
            .await
            .is_err()
    );
    bot_skill_review::cleanup_tick(&changed).await.unwrap();
    assert!(provider
        .mock
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|r| r.0 != "delete"));
    let tombstone = fixture
        .state
        .db
        .one(
            "SELECT status,last_error FROM bot_skill_cleanup WHERE id=?",
            vec![json!(receipt)],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone["status"], "pending");
    assert!(tombstone["last_error"]
        .as_str()
        .unwrap()
        .contains("当前记忆服务"));
    let second = core_skill_registry::ensure(&changed, &actor).await.unwrap();
    let original = core_skill_registry::ensure(&fixture.state, &actor)
        .await
        .unwrap();
    assert_ne!(second["user_id"], original["user_id"]);
    let other_provider = Provider::new().await;
    Arc::make_mut(&mut changed.config).memory_service_id =
        fixture.state.config.memory_service_id.clone();
    Arc::make_mut(&mut changed.config).memory_core_url = other_provider.url.clone();
    assert!(
        core_skill_registry::receipt_identity(&changed, &actor, receipt)
            .await
            .is_err()
    );
    core_skill_registry::ensure(&changed, &actor).await.unwrap();
    assert_eq!(
        fixture
            .state
            .db
            .rows("SELECT id FROM core_skill_registry", vec![])
            .await
            .unwrap()
            .len(),
        3
    );
}

#[tokio::test]
async fn missing_registry_admin_configuration_blocks_extraction_but_preserves_core_memory() {
    let provider = Provider::new().await;
    let mut fixture = Fixture::new(Some(&provider.url), None).await;
    Arc::make_mut(&mut fixture.state.config)
        .memory_core_admin_user_key
        .clear();
    let actor = fixture.actor("alice", "team-a");
    assert_eq!(
        memory_provider::post_core(&fixture.state, &actor, "/v3/skill/extract", json!({}))
            .await
            .unwrap_err()
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    memory_provider::post_core(&fixture.state, &actor, "/v3/core/read", json!({}))
        .await
        .unwrap();
    assert!(provider.registry.data.lock().unwrap().calls.is_empty());
}
