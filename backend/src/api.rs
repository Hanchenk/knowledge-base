use crate::{
    acl, agent, ai,
    auth::{audit, hash, token, Actor},
    db::{id, n, now, s},
    error::{AppError, Result},
    rag::{self, SearchInput},
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn search(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<SearchInput>,
) -> Result<Json<Value>> {
    Ok(Json(json!(rag::search(&state, &actor, input).await?)))
}
#[derive(Deserialize)]
pub struct ChatInput {
    #[serde(flatten)]
    pub search: SearchInput,
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub allow_web: bool,
}
pub async fn chat(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<ChatInput>,
) -> Result<Json<Value>> {
    let state = state.for_tenant(&actor.tenant_id).await?;
    let mut history = Vec::new();
    let mut history_citations = Vec::new();
    if let Some(key) = &input.conversation_id {
        actor.browser()?;
        let Json(rows) = messages(State(state.clone()), actor.clone(), Path(key.clone())).await?;
        if let Some(rows) = rows.as_array() {
            let mut seen = std::collections::HashSet::new();
            for row in rows.iter().rev().take(12).rev() {
                let citations = row["citations"].as_array().cloned().unwrap_or_default();
                let added = citations
                    .iter()
                    .filter_map(|c| c["chunk_id"].as_str())
                    .filter(|id| !seen.contains(*id))
                    .collect::<std::collections::HashSet<_>>();
                // Keep every dependency of any historical answer we send to the model.
                if seen.len() + added.len() > 16 {
                    continue;
                }
                if input
                    .search
                    .space_id
                    .as_ref()
                    .is_some_and(|space| citations.iter().any(|c| c["space_id"] != *space))
                {
                    continue;
                }
                if input.search.document_ids.as_ref().is_some_and(|ids| {
                    citations
                        .iter()
                        .any(|c| !ids.iter().any(|id| c["document_id"] == *id))
                }) {
                    continue;
                }
                seen.extend(added.into_iter().map(str::to_owned));
                history.push(json!({"role":row["role"],"content":row["content"].as_str().unwrap_or("").chars().take(5000).collect::<String>()}));
                history_citations.extend(citations);
            }
        }
    }
    let scope = input.search.space_id.clone();
    let document_ids = input.search.document_ids.clone();
    let mut retrieval = rag::search(&state, &actor, input.search).await?;
    // Always seed attachment identity and introductory evidence, even for a generic
    // "summarize this file" query that has no lexical overlap with its contents.
    let mut attachment_names = Vec::new();
    if let Some(ids) = &document_ids {
        for id in ids {
            let doc = crate::documents::accessible(&state, &actor, id).await?;
            attachment_names.push(s(&doc, "filename").replace(['\n', '\r'], " "));
            for row in state.db.rows("SELECT id,text,page,kind,image_key FROM chunks WHERE document_id=? AND version=? ORDER BY position LIMIT 2", vec![json!(id), doc["version"].clone()]).await? {
                if retrieval.hits.iter().any(|hit| hit["chunk_id"] == row["id"]) { continue; }
                retrieval.hits.push(json!({"chunk_id":row["id"],"document_id":id,"space_id":doc["space_id"],"title":doc["title"],"text":s(&row,"text").chars().take(4000).collect::<String>(),"page":row["page"],"kind":row["kind"],"version":doc["version"],"image_url":if row["image_key"].is_null(){Value::Null}else{json!(format!("/api/chunks/{}/image",s(&row,"id")))},"source_url":format!("/api/documents/{id}/file")}));
            }
        }
        retrieval.query = format!(
            "{}\n\n附件：{}",
            retrieval.query,
            attachment_names.join("、")
        );
        retrieval
            .warnings
            .push("本次围绕所选附件检索；附件已保存到知识空间，访问遵循空间权限".into());
    }
    let mut web_sources = Vec::new();
    let mut tool_calls = Vec::new();
    let engine;
    let answer = if state.config.agent_enabled && state.config.chat() {
        let result = agent::answer(
            &state,
            &actor,
            agent::Input {
                query: retrieval.query.clone(),
                initial: retrieval.hits.clone(),
                history,
                history_citations,
                space_id: scope,
                document_ids,
                studio: None,
                bot: None,
                allow_web: input.allow_web,
            },
        )
        .await?;
        retrieval.hits = result.citations;
        web_sources = result.web_sources;
        tool_calls = result.tools;
        engine = "pi-agent-core";
        result.text
    } else {
        engine = if state.config.chat() {
            "direct-rag"
        } else {
            "excerpts"
        };
        ai::answer(&state, &retrieval.query, &retrieval.hits).await?
    };
    if engine == "pi-agent-core" {
        let citations = regex::Regex::new(r"\[(W?)([1-9][0-9]*)\]").unwrap();
        let mut knowledge_numbers = std::collections::HashSet::new();
        let mut web_numbers = std::collections::HashSet::new();
        for capture in citations.captures_iter(&answer) {
            if let Ok(number) = capture[2].parse::<usize>() {
                if &capture[1] == "W" {
                    web_numbers.insert(number);
                } else {
                    knowledge_numbers.insert(number);
                }
            }
        }
        for (index, hit) in retrieval.hits.iter_mut().enumerate() {
            hit["citation_number"] = json!(index + 1);
            hit["referenced"] = json!(knowledge_numbers.contains(&(index + 1)));
        }
        for (index, source) in web_sources.iter_mut().enumerate() {
            source["citation_number"] = json!(index + 1);
            source["referenced"] = json!(
                web_numbers.contains(&(index + 1))
                    || source["url"]
                        .as_str()
                        .is_some_and(|url| answer.contains(url))
            );
        }
    }
    if input.allow_web
        && (!state.config.agent_enabled || !state.config.agent_web_enabled || !state.config.chat())
    {
        retrieval
            .warnings
            .push("本次未使用联网工具；需要启用 Pi Agent、问答模型及管理员联网策略".into());
    }
    let actor = agent::current_actor(&state, &actor).await?;
    // Recheck after external inference: do not return/store answers based on newly revoked sources.
    let rights = acl::all_rights(&state, &actor).await?;
    if retrieval.hits.iter().any(|h| {
        !rights
            .get(h["space_id"].as_str().unwrap_or(""))
            .is_some_and(|r| r.can_view)
    }) {
        return Err(AppError::forbidden());
    }
    for hit in &retrieval.hits {
        if state
            .db
            .one(
                "SELECT id FROM documents WHERE id=? AND deleted=0 AND version=? AND tenant_id=?",
                vec![
                    hit["document_id"].clone(),
                    hit["version"].clone(),
                    json!(actor.tenant_id),
                ],
            )
            .await?
            .is_none()
        {
            return Err(AppError::bad("资料已更新，请重新提问"));
        }
    }
    let mut conversation_id = None;
    if actor.scopes.is_none() {
        let key = if let Some(key) = input.conversation_id {
            if state
                .db
                .one(
                    "SELECT id FROM conversations WHERE id=? AND user_id=? AND tenant_id=?",
                    vec![json!(key), json!(actor.id), json!(actor.tenant_id)],
                )
                .await?
                .is_none()
            {
                return Err(AppError::missing());
            }
            key
        } else {
            let key = id();
            state.db.exec("INSERT INTO conversations(id,tenant_id,user_id,title,created_at) VALUES(?,?,?,?,?)",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(retrieval.query.chars().take(40).collect::<String>()),json!(now())]).await?;
            key
        };
        let mut tx = state.db.pool.begin().await?;
        state.db.tx_exec(&mut tx,"INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",vec![json!(id()),json!(key),json!(retrieval.query),json!(now())]).await?;
        let answer_id = id();
        state.db.tx_exec(&mut tx,"INSERT INTO messages(id,conversation_id,role,content,citations,created_at) VALUES(?,?,'assistant',?,?,?)",vec![json!(answer_id),json!(key),json!(answer),json!(json!(retrieval.hits).to_string()),json!(now()+1)]).await?;
        state.db.tx_exec(&mut tx,"INSERT INTO agent_message_metadata(message_id,engine,web_sources,tool_calls) VALUES(?,?,?,?)",vec![json!(answer_id),json!(engine),json!(json!(web_sources).to_string()),json!(json!(tool_calls).to_string())]).await?;
        tx.commit().await?;
        conversation_id = Some(key);
    }
    if !state.config.chat() {
        retrieval.warnings.push(
            if state.config.chat_model.is_empty() {
                "未配置问答模型，本次展示原文片段"
            } else {
                "问答模型未启用，本次展示原文片段；请勾选问答模型的“启用”并保存配置"
            }
            .into(),
        );
    }
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "rag.answer",
        None,
        json!({"citation_count":retrieval.hits.len(),"api_key_id":actor.key_id}),
    )
    .await?;
    Ok(Json(
        json!({"answer":answer,"citations":retrieval.hits,"warnings":retrieval.warnings,"mode":retrieval.mode,"conversation_id":conversation_id,"engine":engine,"web_sources":web_sources,"tool_calls":tool_calls}),
    ))
}
pub async fn conversations(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    Ok(Json(json!(state.db.rows("SELECT id,title,created_at FROM conversations WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50",vec![json!(actor.tenant_id),json!(actor.id)]).await?)))
}
pub async fn messages(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    if state
        .db
        .one(
            "SELECT id FROM conversations WHERE id=? AND user_id=? AND tenant_id=?",
            vec![json!(key), json!(actor.id), json!(actor.tenant_id)],
        )
        .await?
        .is_none()
    {
        return Err(AppError::missing());
    }
    let rights = acl::all_rights(&state, &actor).await?;
    let mut messages=state.db.rows("SELECT id,role,content,citations,created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 500",vec![json!(key)]).await?;
    messages.reverse();
    for message in &mut messages {
        let citations: Vec<Value> =
            serde_json::from_str(s(message, "citations")).unwrap_or_default();
        let mut allowed = true;
        for c in &citations {
            if !rights.get(c["space_id"].as_str().unwrap_or("")).is_some_and(|r|r.can_view) || state.db.one("SELECT id FROM documents WHERE id=? AND tenant_id=? AND deleted=0 AND version=?",vec![c["document_id"].clone(),json!(actor.tenant_id),c["version"].clone()]).await?.is_none(){allowed=false;break;}
        }
        if let Some(meta) = state.db.one("SELECT engine,web_sources,tool_calls FROM agent_message_metadata WHERE message_id=?",vec![message["id"].clone()]).await? {
            message.insert("engine".into(),meta["engine"].clone());
            message.insert("web_sources".into(),serde_json::from_str(s(&meta,"web_sources")).unwrap_or(json!([])));
            message.insert("tool_calls".into(),serde_json::from_str(s(&meta,"tool_calls")).unwrap_or(json!([])));
        }
        // Hiding references alone would leak previously retrieved text, so redact the entire assistant answer.
        if !allowed {
            message.insert("web_sources".into(), json!([]));
            message.insert("tool_calls".into(), json!([]));
            message.insert(
                "content".into(),
                json!("此回答引用的资料已更新、删除或不再有访问权限。请重新提问。"),
            );
            message.insert("citations".into(), json!([]));
        } else {
            message.insert("citations".into(), json!(citations));
        }
    }
    Ok(Json(json!(messages)))
}
pub async fn keys(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let mut rows=state.db.rows("SELECT id,name,prefix,scopes,expires_at,revoked,last_used_at,created_at FROM api_keys WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC",vec![json!(actor.tenant_id),json!(actor.id)]).await?;
    for row in &mut rows {
        let scopes = serde_json::from_str::<Value>(s(row, "scopes")).unwrap_or(json!([]));
        row.insert("scopes".into(), scopes);
    }
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
pub struct KeyInput {
    pub name: String,
    pub scopes: Vec<String>,
    #[serde(default = "thirty")]
    pub expires_days: i64,
}
fn thirty() -> i64 {
    30
}
pub async fn create_key(
    State(state): State<AppState>,
    actor: Actor,
    Json(input): Json<KeyInput>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let name = crate::org::label(&input.name, 100)?;
    if input.scopes.is_empty()
        || input.scopes.len() > 3
        || input
            .scopes
            .iter()
            .any(|s| !["search.read", "document.read", "document.write"].contains(&s.as_str()))
        || !(1..=365).contains(&input.expires_days)
    {
        return Err(AppError::bad("密钥权限或有效期无效（1–365 天）"));
    }
    let secret = format!("ak_{}", token());
    let key = id();
    let prefix = &secret[..11];
    let expires = now() + input.expires_days * 86_400_000;
    state.db.exec("INSERT INTO api_keys(id,tenant_id,user_id,name,prefix,secret_hash,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(actor.tenant_id),json!(actor.id),json!(name),json!(prefix),json!(hash(&secret)),json!(json!(input.scopes).to_string()),json!(expires),json!(now())]).await?;
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "api_key.create",
        Some(&key),
        json!({"scopes":input.scopes,"expires_at":expires}),
    )
    .await?;
    Ok(Json(
        json!({"id":key,"key":secret,"prefix":prefix,"expires_at":expires}),
    ))
}
pub async fn revoke_key(
    State(state): State<AppState>,
    actor: Actor,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    actor.browser()?;
    let changed = state
        .db
        .exec(
            "UPDATE api_keys SET revoked=1 WHERE id=? AND tenant_id=? AND user_id=?",
            vec![json!(key), json!(actor.tenant_id), json!(actor.id)],
        )
        .await?;
    if changed != 1 {
        return Err(AppError::missing());
    }
    audit(
        &state,
        &actor.tenant_id,
        &actor.id,
        "api_key.revoke",
        Some(&key),
        json!({}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Page {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
pub async fn audits(
    State(state): State<AppState>,
    actor: Actor,
    Query(page): Query<Page>,
) -> Result<Json<Value>> {
    actor.admin()?;
    let mut rows=state.db.rows("SELECT a.*,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT ? OFFSET ?",vec![json!(actor.tenant_id),json!(page.limit.unwrap_or(50).clamp(1,100)),json!(page.offset.unwrap_or(0).max(0))]).await?;
    for row in &mut rows {
        let details = serde_json::from_str::<Value>(s(row, "details")).unwrap_or(json!({}));
        row.insert("details".into(), details);
    }
    Ok(Json(json!(rows)))
}
pub async fn jobs(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.admin()?;
    Ok(Json(json!(state.db.rows("SELECT j.id,j.document_id,j.version,j.status,j.attempts,j.error,j.created_at,j.finished_at,d.title FROM index_jobs j JOIN documents d ON d.id=j.document_id WHERE j.tenant_id=? ORDER BY j.created_at DESC LIMIT 100",vec![json!(actor.tenant_id)]).await?)))
}
pub async fn stats(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let state = state.for_tenant(&actor.tenant_id).await?;
    let rights = acl::all_rights(&state, &actor).await?;
    let spaces: Vec<_> = rights
        .iter()
        .filter(|(_, r)| r.can_view)
        .map(|(id, _)| id)
        .collect();
    let mut counts = json!({"documents":0,"chunks":0,"images":0,"pending":0});
    if !spaces.is_empty() {
        let placeholders = vec!["?"; spaces.len()].join(",");
        let mut args = vec![json!(actor.tenant_id)];
        args.extend(spaces.iter().map(|s| json!(s)));
        let docs=state.db.one(&format!("SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END),0) AS pending FROM documents WHERE tenant_id=? AND space_id IN ({placeholders}) AND deleted=0"),args.clone()).await?.unwrap();
        let chunks=state.db.one(&format!("SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN c.kind='image' THEN 1 ELSE 0 END),0) AS images FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.tenant_id=? AND c.space_id IN ({placeholders}) AND d.deleted=0 AND c.version=d.version"),args).await?.unwrap();
        counts = json!({"documents":n(&docs,"count"),"pending":n(&docs,"pending"),"chunks":n(&chunks,"count"),"images":n(&chunks,"images")});
    }
    Ok(Json(
        json!({"counts":counts,"spaces":spaces.len(),"capabilities":{"semantic":state.config.embeddings(),"vision":state.config.vision(),"chat":state.config.chat(),"agent":state.config.agent_enabled && state.config.chat(),"web":state.config.agent_enabled && state.config.agent_web_enabled && state.config.chat(),"sso":state.config.oidc(),"database":if state.db.postgres {if state.config.qdrant_url.is_empty(){"PostgreSQL + pgvector"}else{"PostgreSQL + Qdrant"}}else{"SQLite · 开发模式"},"storage":crate::storage::label(&state,&actor.tenant_id).await?,"models":{"embedding":state.config.embedding_model,"vision":state.config.vision_model,"chat":state.config.chat_model}},"mcp_url":format!("{}/mcp",state.config.public_url.trim_end_matches('/'))}),
    ))
}
