use crate::{
    auth::Actor,
    db::{n, s},
    error::{AppError, Result},
    AppState,
};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};

#[derive(Default, Clone, Copy, Serialize, Debug, PartialEq)]
pub struct Rights {
    pub can_view: bool,
    pub can_create: bool,
    pub can_manage: bool,
}
impl Rights {
    fn add(&mut self, other: Self) {
        self.can_view |= other.can_view;
        self.can_create |= other.can_create;
        self.can_manage |= other.can_manage;
    }
    fn remove(&mut self, other: Self) {
        self.can_view &= !other.can_view;
        self.can_create &= !other.can_create;
        self.can_manage &= !other.can_manage;
    }
}
pub fn ancestors(start: &str, parents: &HashMap<String, String>) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut current = start.to_owned();
    while !current.is_empty() && set.insert(current.clone()) {
        current = parents.get(&current).cloned().unwrap_or_default();
    }
    set
}
pub async fn all_rights(state: &AppState, actor: &Actor) -> Result<HashMap<String, Rights>> {
    let current = state
        .db
        .one(
            "SELECT id,role,department_id FROM users WHERE id=? AND tenant_id=? AND active=1",
            vec![json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        .ok_or_else(AppError::unauthorized)?;
    if let Some(key) = &actor.key_id {
        if state.db.one("SELECT id FROM api_keys WHERE id=? AND user_id=? AND tenant_id=? AND revoked=0 AND expires_at>?",vec![json!(key),json!(actor.id),json!(actor.tenant_id),json!(crate::db::now())]).await?.is_none(){return Err(AppError::unauthorized());}
    }
    let mut fresh = actor.clone();
    fresh.role = s(&current, "role").into();
    fresh.department_id = s(&current, "department_id").into();
    let actor = &fresh;
    let spaces = state
        .db
        .rows(
            "SELECT s.id FROM spaces s LEFT JOIN personal_spaces p ON p.space_id=s.id WHERE s.tenant_id=? AND (p.user_id IS NULL OR p.user_id=?)",
            vec![json!(actor.tenant_id),json!(actor.id)],
        )
        .await?;
    let mut rights: HashMap<_, _> = spaces
        .iter()
        .map(|s| (s["id"].as_str().unwrap().to_owned(), Rights::default()))
        .collect();
    let personal = state
        .db
        .one(
            "SELECT space_id FROM personal_spaces WHERE user_id=?",
            vec![json!(actor.id)],
        )
        .await?;
    if let Some(ref space) = personal {
        if let Some(r) = rights.get_mut(s(space, "space_id")) {
            *r = Rights {
                can_view: true,
                can_create: true,
                can_manage: true,
            };
        }
    }
    // API keys always inherit current rights; admin is still constrained by key scopes at the operation boundary.
    if actor.role == "admin" {
        for value in rights.values_mut() {
            *value = Rights {
                can_view: true,
                can_create: true,
                can_manage: true,
            };
        }
        return Ok(rights);
    }
    let departments = state
        .db
        .rows(
            "SELECT id,parent_id FROM departments WHERE tenant_id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let users = state
        .db
        .rows(
            "SELECT id,manager_id FROM users WHERE tenant_id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let department_parents = departments
        .iter()
        .map(|r| (s(r, "id").to_owned(), s(r, "parent_id").to_owned()))
        .collect();
    let manager_parents = users
        .iter()
        .map(|r| (s(r, "id").to_owned(), s(r, "manager_id").to_owned()))
        .collect();
    let department_chain = ancestors(&actor.department_id, &department_parents);
    let manager_chain = ancestors(&actor.id, &manager_parents);
    let direct_manager = manager_parents.get(&actor.id).cloned().unwrap_or_default();
    let grants = state
        .db
        .rows(
            "SELECT g.* FROM grants g JOIN spaces s ON s.id=g.space_id WHERE s.tenant_id=?",
            vec![json!(actor.tenant_id)],
        )
        .await?;
    let mut deny: HashMap<String, Rights> = HashMap::new();
    for grant in grants {
        let principal = s(&grant, "principal_id");
        let descendants = n(&grant, "include_descendants") == 1;
        let matches = match s(&grant, "principal_type") {
            "tenant" => principal == actor.tenant_id,
            "user" => principal == actor.id,
            "department" => {
                principal == actor.department_id
                    || descendants && department_chain.contains(principal)
            }
            "reports" => {
                principal != actor.id
                    && if descendants {
                        manager_chain.contains(principal)
                    } else {
                        direct_manager == principal
                    }
            }
            _ => false,
        };
        if !matches {
            continue;
        }
        let space = s(&grant, "space_id").to_owned();
        let manage = n(&grant, "can_manage") == 1;
        let value = Rights {
            can_view: n(&grant, "can_view") == 1 || manage,
            can_create: n(&grant, "can_create") == 1 || manage,
            can_manage: manage,
        };
        if s(&grant, "effect") == "deny" {
            deny.entry(space).or_default().add(value);
        } else if let Some(right) = rights.get_mut(&space) {
            right.add(value);
        }
    }
    for (space, value) in deny {
        if let Some(right) = rights.get_mut(&space) {
            right.remove(value);
            if !right.can_view || !right.can_create {
                right.can_manage = false;
            }
        }
    }
    if let Some(space) = personal {
        if let Some(r) = rights.get_mut(s(&space, "space_id")) {
            *r = Rights {
                can_view: true,
                can_create: true,
                can_manage: true,
            };
        }
    }
    Ok(rights)
}
pub async fn require(
    state: &AppState,
    actor: &Actor,
    space: &str,
    operation: &str,
) -> Result<Rights> {
    let rights = all_rights(state, actor)
        .await?
        .get(space)
        .copied()
        .ok_or_else(AppError::missing)?;
    if match operation {
        "view" => rights.can_view,
        "create" => rights.can_create,
        "manage" => rights.can_manage,
        _ => false,
    } {
        Ok(rights)
    } else {
        Err(AppError::forbidden())
    }
}
