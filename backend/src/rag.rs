use crate::{
    acl, ai,
    auth::{audit, Actor},
    db::{n, s, Record},
    error::{AppError, Result},
    retrieval::{self, Intent},
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub fn tokens(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut result = Vec::new();
    let mut latin = String::new();
    let mut cjk = String::new();
    fn flush(latin: &mut String, cjk: &mut String, out: &mut Vec<String>) {
        if !latin.is_empty() {
            out.push(std::mem::take(latin));
        }
        let chars: Vec<_> = cjk.chars().collect();
        for window in chars.windows(2) {
            out.push(window.iter().collect());
        }
        if chars.len() == 1 {
            out.push(cjk.clone());
        }
        cjk.clear();
    }
    for c in lower.chars() {
        if ('\u{3400}'..='\u{9fff}').contains(&c) {
            if !latin.is_empty() {
                flush(&mut latin, &mut cjk, &mut result);
            }
            cjk.push(c);
        } else if c.is_ascii_alphanumeric() || c == '_' {
            if !cjk.is_empty() {
                flush(&mut latin, &mut cjk, &mut result);
            }
            latin.push(c);
        } else {
            flush(&mut latin, &mut cjk, &mut result);
        }
    }
    flush(&mut latin, &mut cjk, &mut result);
    result
}
#[derive(Deserialize, Clone)]
pub struct SearchInput {
    #[serde(default)]
    pub query: String,
    pub space_id: Option<String>,
    pub document_ids: Option<Vec<String>>,
    pub limit: Option<usize>,
    pub image_base64: Option<String>,
    pub image_mime: Option<String>,
}
#[derive(Serialize)]
pub struct SearchOutput {
    pub query: String,
    pub mode: String,
    pub hits: Vec<Value>,
    pub warnings: Vec<String>,
}
pub async fn search(state: &AppState, actor: &Actor, input: SearchInput) -> Result<SearchOutput> {
    actor.scope("search.read")?;
    if let Some(ids) = &input.document_ids {
        if ids.is_empty() || ids.len() > 10 {
            return Err(AppError::bad("每次提问请选择 1 至 10 个附件"));
        }
        for id in ids {
            let doc = crate::documents::accessible(state, actor, id).await?;
            if input
                .space_id
                .as_ref()
                .is_some_and(|space| space != s(&doc, "space_id"))
            {
                return Err(AppError::forbidden());
            }
            if s(&doc, "status") != "ready" || n(&doc, "indexed_version") != n(&doc, "version") {
                return Err(AppError::bad("附件尚未完成索引，请等待索引完成后提问"));
            }
        }
    }
    let resolved = state.for_tenant(&actor.tenant_id).await?;
    let state = &resolved;
    if input.query.chars().count() > 2000 {
        return Err(AppError::bad("检索问题不能超过 2000 字符"));
    }
    let mut query = input.query.trim().to_owned();
    if let Some(encoded) = input.image_base64 {
        use base64::Engine;
        if encoded.len() > 8_000_000 {
            return Err(AppError::bad("查询图片不能超过 6 MB"));
        }
        if !state.config.vision() {
            return Err(AppError::bad("请先配置 VISION_MODEL 以启用图片查询"));
        }
        let mime = input.image_mime.unwrap_or_else(|| "image/jpeg".into());
        if !["image/jpeg", "image/png", "image/webp"].contains(&mime.as_str()) {
            return Err(AppError::bad("不支持的图片格式"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(|_| AppError::bad("图片编码无效"))?;
        let description = ai::vision(state, &bytes, &mime).await?;
        query = format!("{query}\n{description}");
    }
    if query.is_empty() {
        return Err(AppError::bad("请输入问题或上传查询图片"));
    }
    let rights = acl::all_rights(state, actor).await?;
    let spaces: Vec<String> = rights
        .iter()
        .filter(|(id, r)| r.can_view && input.space_id.as_ref().is_none_or(|v| *id == v))
        .map(|(id, _)| id.clone())
        .collect();
    if input.space_id.as_ref().is_some_and(|v| !spaces.contains(v)) {
        return Err(AppError::forbidden());
    }
    let mut warnings = Vec::new();
    let mut candidates: HashMap<String, Record> = HashMap::new();
    let mut ranked_lists: Vec<Vec<String>> = Vec::new();
    let mut semantic_used = false;
    let intent = Intent::parse(&query);
    if !spaces.is_empty() {
        let placeholders = vec!["?"; spaces.len()].join(",");
        let mut filter=format!("c.tenant_id=? AND c.space_id IN ({placeholders}) AND d.deleted=0 AND c.version=d.indexed_version AND d.indexed_version=d.version AND d.status='ready'");
        let select="SELECT c.id,c.document_id,c.space_id,c.text,c.page,c.kind,c.image_key,c.embedding,c.embedding_model,d.title,d.filename,d.version FROM chunks c JOIN documents d ON d.id=c.document_id";
        let mut args = vec![json!(actor.tenant_id)];
        args.extend(spaces.iter().map(|s| json!(s)));
        // Resolve report identity before both lexical and vector recall. Dates in
        // incident descriptions must not pull a different month's report in.
        if intent.dated() {
            let documents = state.db.rows(&format!("SELECT d.id,d.title,d.filename FROM documents d WHERE d.tenant_id=? AND d.space_id IN ({placeholders}) AND d.deleted=0 AND d.status='ready' AND d.indexed_version=d.version"),args.clone()).await?;
            let matching: Vec<_> = documents
                .iter()
                .filter(|d| intent.document_matches(d))
                .collect();
            let best = matching
                .iter()
                .filter(|d| intent.dated_document_matches(d))
                .map(|d| retrieval::title_overlap(&query, s(d, "title")))
                .max()
                .unwrap_or(0);
            let selected: Vec<_> = matching
                .into_iter()
                .filter(|d| {
                    best < 2
                        || (intent.dated_document_matches(d)
                            && retrieval::title_overlap(&query, s(d, "title")) >= best.div_ceil(2))
                })
                .collect();
            if selected.is_empty() {
                filter.push_str(" AND 1=0");
            } else {
                filter.push_str(&format!(
                    " AND c.document_id IN ({})",
                    vec!["?"; selected.len()].join(",")
                ));
                args.extend(selected.iter().map(|d| json!(s(d, "id"))));
            }
            warnings
                .push("已按问题中的年月限定报告范围；未指定年份时可包含多个年份的同月资料".into());
        }
        if let Some(ids) = &input.document_ids {
            filter.push_str(&format!(
                " AND c.document_id IN ({})",
                vec!["?"; ids.len()].join(",")
            ));
            args.extend(ids.iter().map(|id| json!(id)));
        }
        intent.constrain_chunks(&mut filter, &mut args);
        let query_tokens = tokens(&query);
        let unique: HashSet<_> = query_tokens.iter().take(256).cloned().collect();
        if state.db.postgres {
            let tsquery = unique
                .iter()
                .filter(|s| !s.is_empty())
                .take(256)
                .cloned()
                .collect::<Vec<_>>()
                .join(" | ");
            if !tsquery.is_empty() {
                let mut keyword_args = args.clone();
                keyword_args.push(json!(tsquery));
                keyword_args.push(json!(tsquery));
                let lexical=state.db.rows(&format!("{select} WHERE {filter} AND to_tsvector('simple',c.search_tokens) @@ to_tsquery('simple',?) ORDER BY ts_rank_cd(to_tsvector('simple',c.search_tokens),to_tsquery('simple',?)) DESC LIMIT 64"),keyword_args).await?;
                ranked_lists.push(lexical.iter().map(|r| s(r, "id").to_owned()).collect());
                for row in lexical {
                    candidates.insert(s(&row, "id").to_owned(), row);
                }
            }
        } else {
            let rows = state
                .db
                .rows(
                    // Sort only IDs before fetching full rows. Sorting vectors with
                    // each row creates large SQLite temporary files on disk.
                    &format!("{select} WHERE c.id IN (SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id WHERE {filter} ORDER BY c.id LIMIT 20001)"),
                    args.clone(),
                )
                .await?;
            if rows.len() > 20000 {
                warnings.push(
                    "开发模式最多扫描 20,000 个片段；较大知识库请使用 PostgreSQL 部署".into(),
                );
            }
            let corpus: Vec<_> = rows
                .iter()
                .take(20000)
                .map(|r| tokens(&format!("{} {}", s(r, "title"), s(r, "text"))))
                .collect();
            let average =
                corpus.iter().map(Vec::len).sum::<usize>() as f64 / corpus.len().max(1) as f64;
            let mut frequencies: HashMap<String, usize> = HashMap::new();
            for terms in &corpus {
                let found: HashSet<_> = terms.iter().collect();
                for term in &unique {
                    if found.contains(term) {
                        *frequencies.entry(term.clone()).or_default() += 1;
                    }
                }
            }
            let mut scored: Vec<(f64, String)> = rows
                .iter()
                .take(20000)
                .enumerate()
                .map(|(i, r)| {
                    let terms = &corpus[i];
                    let mut score = 0.0;
                    for term in &unique {
                        let tf = terms.iter().filter(|v| *v == term).count() as f64;
                        if tf == 0.0 {
                            continue;
                        }
                        let df = *frequencies.get(term).unwrap_or(&0) as f64;
                        let idf = (1.0 + (corpus.len() as f64 - df + 0.5) / (df + 0.5)).ln();
                        score += idf * (tf * 2.2)
                            / (tf + 1.2 * (0.25 + 0.75 * terms.len() as f64 / average.max(1.0)));
                    }
                    (score, s(r, "id").to_owned())
                })
                .filter(|(score, _)| *score > 0.0)
                .collect();
            scored.sort_by(|a, b| b.0.total_cmp(&a.0));
            ranked_lists.push(scored.iter().take(64).map(|(_, id)| id.clone()).collect());
            for row in rows.into_iter().take(20000) {
                candidates.insert(s(&row, "id").to_owned(), row);
            }
        }
        if state.config.embeddings() {
            match ai::embeddings(state, &[query.clone()]).await {
                Ok(embeddings) => {
                    let vector = &embeddings[0];
                    let mut vector_available = true;
                    let ranked = if !state.config.qdrant_url.is_empty() {
                        let eligible=state.db.rows(&format!("SELECT DISTINCT c.document_id FROM chunks c JOIN documents d ON d.id=c.document_id WHERE {filter}"),args.clone()).await?;
                        let documents = eligible
                            .iter()
                            .map(|r| s(r, "document_id").to_owned())
                            .collect::<Vec<_>>();
                        match crate::qdrant::search(
                            state,
                            &actor.tenant_id,
                            &spaces,
                            &documents,
                            vector,
                        )
                        .await
                        {
                            Ok(ids) if !ids.is_empty() => {
                                let mut filtered = args.clone();
                                filtered.extend(ids.iter().map(|v| json!(v)));
                                let rows = state
                                    .db
                                    .rows(
                                        &format!(
                                            "{select} WHERE {filter} AND c.id IN ({})",
                                            vec!["?"; ids.len()].join(",")
                                        ),
                                        filtered,
                                    )
                                    .await?;
                                let valid: HashSet<String> =
                                    rows.iter().map(|r| s(r, "id").into()).collect();
                                for row in rows {
                                    candidates.insert(s(&row, "id").into(), row);
                                }
                                ids.into_iter().filter(|id| valid.contains(id)).collect()
                            }
                            Ok(_) => vec![],
                            Err(error) => {
                                vector_available = false;
                                tracing::warn!(%error,"Qdrant search unavailable");
                                warnings.push("向量索引暂不可用，本次使用关键词检索".into());
                                vec![]
                            }
                        }
                    } else if state.db.postgres {
                        let mut semantic_args = args.clone();
                        semantic_args.push(json!(state.config.embedding_identity()));
                        semantic_args.push(json!(json!(vector).to_string()));
                        semantic_args.push(json!(json!(vector).to_string()));
                        let semantic=state.db.rows(&format!("{select} WHERE {filter} AND c.embedding_model=? AND c.embedding_vector IS NOT NULL AND (c.embedding_vector <=> CAST(? AS vector))<0.8 ORDER BY c.embedding_vector <=> CAST(? AS vector) LIMIT 64"),semantic_args).await?;
                        let ids = semantic.iter().map(|r| s(r, "id").to_owned()).collect();
                        for row in semantic {
                            candidates.insert(s(&row, "id").to_owned(), row);
                        }
                        ids
                    } else {
                        let mut scores: Vec<_> = candidates
                            .iter()
                            .filter(|(_, r)| {
                                s(r, "embedding_model") == state.config.embedding_identity()
                            })
                            .filter_map(|(id, r)| {
                                let embed: Vec<f64> =
                                    serde_json::from_str(s(r, "embedding")).ok()?;
                                let score = cosine(vector, &embed);
                                (score > 0.2).then_some((score, id.clone()))
                            })
                            .collect();
                        scores.sort_by(|a, b| b.0.total_cmp(&a.0));
                        scores.into_iter().take(64).map(|(_, id)| id).collect()
                    };
                    ranked_lists.push(ranked);
                    semantic_used = vector_available;
                }
                Err(error) => {
                    tracing::warn!(%error,"semantic search unavailable");
                    warnings.push("向量服务暂不可用，本次使用关键词检索".into());
                }
            }
        } else {
            warnings.push("未配置向量模型，当前使用关键词检索".into());
        }
        if intent.summary && intent.dated() {
            // Aggregate questions need every station, not the three best rows.
            // These snapshots were constructed from the whole workbook during
            // indexing and remain subject to the exact same ACL/version filter.
            let summaries = state.db.rows(&format!("{select} WHERE {filter} AND c.kind='table_summary' ORDER BY c.document_id,c.position LIMIT 100"), args.clone()).await?;
            let ids = summaries
                .iter()
                .filter(|r| intent.chunk_matches(r))
                .map(|r| s(r, "id").to_owned())
                .collect();
            ranked_lists.push(ids);
            for row in summaries {
                candidates.insert(s(&row, "id").to_owned(), row);
            }
        }
    }
    let mode = if semantic_used { "hybrid" } else { "keyword" }.to_owned();
    let mut scores: HashMap<String, f64> = HashMap::new();
    for list in ranked_lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(id.clone()).or_default() += 1.0 / (60.0 + rank as f64 + 1.0);
        }
    }
    let mut fused: Vec<_> = scores.into_iter().collect();
    for (id, score) in &mut fused {
        *score += retrieval::evidence_bonus(&intent, &query, &candidates[id]);
    }
    fused.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let fresh_rights = acl::all_rights(state, actor).await?;
    let limit = input.limit.unwrap_or(6).clamp(1, 20);
    let mut per_doc: HashMap<String, usize> = HashMap::new();
    let mut hits = Vec::new();
    for (id, score) in fused {
        let row = &candidates[&id];
        if !intent.chunk_matches(row) {
            continue;
        }
        if !fresh_rights
            .get(s(row, "space_id"))
            .is_some_and(|r| r.can_view)
        {
            continue;
        }
        let count = per_doc.entry(s(row, "document_id").into()).or_default();
        if *count >= 3 {
            continue;
        }
        *count += 1;
        hits.push(json!({"chunk_id":id,"document_id":s(row,"document_id"),"space_id":s(row,"space_id"),"title":s(row,"title"),"text":s(row,"text"),"page":n(row,"page"),"kind":s(row,"kind"),"version":n(row,"version"),"score":score,"image_url":row.get("image_key").filter(|v|!v.is_null()).map(|_|format!("/api/chunks/{id}/image")),"source_url":format!("/api/documents/{}/file",s(row,"document_id"))}));
        if hits.len() >= limit {
            break;
        }
    }
    audit(
        state,
        &actor.tenant_id,
        &actor.id,
        "search.query",
        input.space_id.as_deref(),
        json!({"mode":mode,"result_count":hits.len(),"api_key_id":actor.key_id}),
    )
    .await?;
    Ok(SearchOutput {
        query,
        mode,
        hits,
        warnings,
    })
}
fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let dot = a.iter().zip(b).map(|(a, b)| a * b).sum::<f64>();
    let norm = (a.iter().map(|v| v * v).sum::<f64>() * b.iter().map(|v| v * v).sum::<f64>()).sqrt();
    if norm == 0.0 {
        0.0
    } else {
        dot / norm
    }
}
