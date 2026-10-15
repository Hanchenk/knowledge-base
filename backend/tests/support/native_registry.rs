use axum::{
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Data {
    pub users: HashMap<String, Value>,
    pub teams: Vec<Value>,
    pub agents: Vec<Value>,
    pub calls: Vec<String>,
    pub fail_after: Option<String>,
    pub corrupt: Option<String>,
}
#[derive(Clone, Default)]
pub struct NativeRegistry {
    pub data: Arc<Mutex<Data>>,
}
impl NativeRegistry {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/v3/meta/{*path}", post(handle))
            .route("/v3/internal/meta/user/list-by-instance", post(handle))
            .with_state(self.clone())
    }
}
async fn handle(
    State(registry): State<NativeRegistry>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(headers["authorization"], "Bearer core-fixture-secret");
    let service = headers["x-tdai-service-id"].to_str().unwrap();
    let path = uri.path();
    let mut data = registry.data.lock().unwrap();
    data.calls.push(path.into());
    let key = headers
        .get("x-tdai-user-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let owner = data
        .users
        .get(key)
        .filter(|v| v["service"] == service)
        .cloned();
    if path != "/v3/meta/auth/verify"
        && path != "/v3/internal/meta/user/list-by-instance"
        && path != "/v3/meta/user/create-with-key"
        && owner.is_none()
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code":401,"message":"invalid_user_key"})),
        );
    }
    let mut value = match path {
        "/v3/meta/auth/verify" => {
            json!({"valid":data.users.get(body["user_key"].as_str().unwrap()).filter(|v|v["service"]==service).is_some(),"user":data.users.get(body["user_key"].as_str().unwrap()).filter(|v|v["service"]==service)})
        }
        "/v3/meta/user/create-with-key" => {
            assert_eq!(key, "registry-admin-secret");
            let key = body["user_key"].as_str().unwrap().to_owned();
            assert!(!data.users.contains_key(&key));
            let user = json!({"user_id":format!("usr-native-{}",data.users.len()),"user_type":"normal","status":"active","username":body["username"],"external_id":body["external_id"],"auth_provider":body["auth_provider"],"service":service});
            data.users.insert(key.clone(), user.clone());
            json!({"user_id":user["user_id"],"user_type":"normal","default_user_key":key})
        }
        "/v3/internal/meta/user/list-by-instance" => {
            let items: Vec<_> = data
                .users
                .values()
                .filter(|v| {
                    v["service"] == service
                        && body["user_ids"].as_array().unwrap().contains(&v["user_id"])
                })
                .cloned()
                .collect();
            json!({"total":items.len(),"items":items})
        }
        "/v3/meta/team/list" => {
            let items: Vec<_> = data
                .teams
                .iter()
                .filter(|v| {
                    v["service"] == service
                        && v["owner_user_id"] == body["user_id"]
                        && v["name"] == body["name"]
                })
                .cloned()
                .collect();
            json!({"total":items.len(),"items":items})
        }
        "/v3/meta/team/create" => {
            assert_eq!(body["owner_user_id"], owner.as_ref().unwrap()["user_id"]);
            let mut team = body.clone();
            team["team_id"] = json!(format!("team-native-{}", data.teams.len()));
            team["service"] = json!(service);
            data.teams.push(team.clone());
            team
        }
        "/v3/meta/team/get" => data
            .teams
            .iter()
            .find(|v| v["service"] == service && v["team_id"] == body["team_id"])
            .unwrap()
            .clone(),
        "/v3/meta/agent/list" => {
            let items: Vec<_> = data
                .agents
                .iter()
                .filter(|v| {
                    v["service"] == service
                        && v["team_id"] == body["team_id"]
                        && v["owner_user_id"] == body["owner_user_id"]
                        && v["name"] == body["name"]
                })
                .cloned()
                .collect();
            json!({"total":items.len(),"items":items})
        }
        "/v3/meta/agent/create" => {
            assert_eq!(body["owner_user_id"], owner.as_ref().unwrap()["user_id"]);
            assert_eq!(body["visibility"], "private");
            assert!(data
                .teams
                .iter()
                .any(|v| v["team_id"] == body["team_id"]
                    && v["owner_user_id"] == body["owner_user_id"]));
            let mut agent = body.clone();
            agent["agent_id"] = json!(format!("agent-native-{}", data.agents.len()));
            agent["service"] = json!(service);
            data.agents.push(agent.clone());
            agent
        }
        "/v3/meta/agent/get" => data
            .agents
            .iter()
            .find(|v| v["service"] == service && v["agent_id"] == body["agent_id"])
            .unwrap()
            .clone(),
        _ => panic!("Unexpected registry path"),
    };
    if data.fail_after.as_deref() == Some(path) {
        data.fail_after = None;
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":503})));
    }
    if let Some(field) = &data.corrupt {
        if path == "/v3/meta/agent/get" || path == "/v3/meta/agent/create" {
            value[field] = json!("foreign");
        }
    }
    (StatusCode::OK, Json(json!({"code":0,"data":value})))
}
