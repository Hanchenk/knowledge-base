use atlas_server::{config::Config, indexer, seed, AppState};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "atlas_server=info,tower_http=info".into()),
        )
        .init();
    let state = AppState::new(Config::load()?).await?;
    seed::initialize(&state).await?;
    atlas_server::qdrant::backfill(&state).await?;
    if state.config.worker_enabled || std::env::args().any(|v| v == "--worker") {
        tokio::spawn(atlas_server::bot::worker(state.clone()));
        tokio::spawn(atlas_server::bot_memory::worker(state.clone()));
        tokio::spawn(atlas_server::bot_cloud::worker(state.clone()));
        for _ in 0..2 {
            tokio::spawn(atlas_server::studio::worker(state.clone()));
        }
    }
    if std::env::args().any(|v| v == "--worker") {
        indexer::worker(state).await;
        return Ok(());
    }
    if state.config.worker_enabled {
        tokio::spawn(indexer::worker(state.clone()));
    }
    let listener = tokio::net::TcpListener::bind(&state.config.bind_address).await?;
    tracing::info!(address=%state.config.bind_address,"Atlas API ready");
    axum::serve(listener, atlas_server::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
