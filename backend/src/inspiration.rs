use crate::{
    auth::Actor,
    db::{id, n, now, s},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DURATION_MS: i64 = 15_000;
const RUN_LIFETIME_MS: i64 = 24 * 60 * 60 * 1000;

pub async fn start(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    let run = id();
    let timestamp = now();
    state.db.exec(
        "DELETE FROM inspiration_runs WHERE tenant_id=? AND user_id=? AND started_at<? AND score IS NULL",
        vec![json!(actor.tenant_id), json!(actor.id), json!(timestamp - RUN_LIFETIME_MS)],
    ).await?;
    state
        .db
        .exec(
            "INSERT INTO inspiration_runs(id,tenant_id,user_id,started_at) VALUES(?,?,?,?)",
            vec![
                json!(run),
                json!(actor.tenant_id),
                json!(actor.id),
                json!(timestamp),
            ],
        )
        .await?;
    Ok(Json(json!({"id":run, "duration_seconds":15})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    pub score: i64,
}

pub async fn finish(
    State(state): State<AppState>,
    actor: Actor,
    Path(run): Path<String>,
    Json(input): Json<Finish>,
) -> Result<Json<Value>> {
    actor.browser()?;
    if !(0..=20).contains(&input.score) {
        return Err(AppError::bad("成绩必须在 0 到 20 颗星光之间"));
    }
    let timestamp = now();
    let mut tx = state.db.pool.begin().await?;
    // Conditional write locks the run before inspecting it, including concurrent retries.
    let changed = state.db.tx_exec(&mut tx,
        "UPDATE inspiration_runs SET score=?,finished_at=? WHERE id=? AND tenant_id=? AND user_id=? AND score IS NULL AND started_at<=? AND started_at>=?",
        vec![json!(input.score), json!(timestamp), json!(run), json!(actor.tenant_id), json!(actor.id), json!(timestamp-DURATION_MS), json!(timestamp-RUN_LIFETIME_MS)],
    ).await?;
    let record = state.db.tx_one(&mut tx,
        "SELECT score,started_at FROM inspiration_runs WHERE id=? AND tenant_id=? AND user_id=?",
        vec![json!(run), json!(actor.tenant_id), json!(actor.id)],
    ).await?.ok_or_else(AppError::missing)?;
    if changed == 0 {
        if record["score"].is_null() {
            return Err(AppError::bad(
                if timestamp - n(&record, "started_at") < DURATION_MS {
                    "游戏尚未结束，请稍后重试"
                } else {
                    "本次游戏已过期，请重新开始"
                },
            ));
        }
        if n(&record, "score") != input.score {
            return Err(AppError::bad("本次游戏成绩已提交，不能修改"));
        }
    } else {
        state.db.tx_exec(&mut tx,
            "INSERT INTO inspiration_scores(tenant_id,user_id,best_score,achieved_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET best_score=excluded.best_score,achieved_at=excluded.achieved_at WHERE excluded.best_score>inspiration_scores.best_score",
            vec![json!(actor.tenant_id), json!(actor.id), json!(input.score), json!(timestamp)],
        ).await?;
    }
    tx.commit().await?;
    let mut result = standings(&state, &actor).await?;
    result["submitted_score"] = json!(input.score);
    Ok(Json(result))
}

pub async fn leaderboard(State(state): State<AppState>, actor: Actor) -> Result<Json<Value>> {
    actor.browser()?;
    Ok(Json(standings(&state, &actor).await?))
}

async fn standings(state: &AppState, actor: &Actor) -> Result<Value> {
    let rows = state.db.rows(
        "WITH ranked AS (SELECT sc.user_id,u.name,sc.best_score,RANK() OVER(ORDER BY sc.best_score DESC) AS rank,ROW_NUMBER() OVER(ORDER BY sc.best_score DESC,sc.achieved_at,sc.user_id) AS position,COUNT(*) OVER() AS total FROM inspiration_scores sc JOIN users u ON u.id=sc.user_id AND u.tenant_id=sc.tenant_id AND u.active=1 WHERE sc.tenant_id=?) SELECT * FROM ranked WHERE position<=10 OR user_id=? ORDER BY position",
        vec![json!(actor.tenant_id), json!(actor.id)],
    ).await?;
    let entry = |row: &crate::db::Record| {
        json!({
            "user_id":s(row,"user_id"), "name":s(row,"name"), "score":n(row,"best_score"),
            "rank":n(row,"rank"), "is_me":s(row,"user_id")==actor.id,
        })
    };
    Ok(json!({
        "entries":rows.iter().filter(|r|n(r,"position")<=10).map(entry).collect::<Vec<_>>(),
        "me":rows.iter().find(|r|s(r,"user_id")==actor.id).map(entry),
        "total":rows.first().map(|r|n(r,"total")).unwrap_or(0),
    }))
}
