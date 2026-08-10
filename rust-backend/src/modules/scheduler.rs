use serde_json::Value;
use std::time::Instant;
use tracing::{info, warn};

use super::github_cache;
use super::runner::{execute_module, is_due, parse_schedule};
use crate::state::AppState;

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const GITHUB_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// Polls active module configs and triggers due runs. DB state is the single
/// source of truth, so config changes take effect on the next tick without
/// any registration bookkeeping.
///
/// Also refreshes the GitHub release cache every 6 hours so the Store and
/// Sidebar version checks never hit the GitHub API rate limit.
pub async fn run_module_scheduler(state: AppState) {
    info!("Module scheduler started (tick {}s)", POLL_INTERVAL.as_secs());
    let mut last_github_refresh: Option<Instant> = None;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        if let Err(e) = tick(&state).await {
            warn!("Module scheduler tick failed: {e}");
        }

        // Refresh GitHub cache every 6 hours
        let should_refresh = last_github_refresh
            .map(|t| t.elapsed() >= GITHUB_REFRESH_INTERVAL)
            .unwrap_or(true);
        if should_refresh {
            last_github_refresh = Some(Instant::now());
            let state2 = state.clone();
            tokio::spawn(async move {
                refresh_github_cache(&state2).await;
            });
        }
    }
}

/// Pre-warms the GitHub release cache for all modules in all registries
/// plus the ZFS-Dashboard repo itself.
async fn refresh_github_cache(state: &AppState) {
    use crate::modules::registry;

    let mut repo_urls = vec!["https://github.com/ZFS-Dashboard/ZFS-Dashboard".to_string()];

    // Collect all module repo URLs from all configured registries
    if let Ok(registries) = crate::routes::module_store::configured_registries(state).await {
        for (_, url, _) in &registries {
            if let Ok(index) = registry::fetch_index(url).await {
                for m in &index.modules {
                    if !repo_urls.contains(&m.repository_url) {
                        repo_urls.push(m.repository_url.clone());
                    }
                }
            }
        }
    }

    github_cache::refresh_all(&state.redis, &repo_urls).await;
    info!("GitHub cache refreshed ({} repos)", repo_urls.len());
}

async fn tick(state: &AppState) -> Result<(), String> {
    let Some(pg) = state.pg.as_ref() else { return Ok(()) };

    let rows = pg
        .query(
            "SELECT m.id, c.config,
                    (SELECT MAX(started_at) FROM module_runs r WHERE r.module_id = m.id) AS last_run,
                    EXISTS(SELECT 1 FROM module_runs r WHERE r.module_id = m.id
                           AND r.finished_at IS NULL
                           AND r.started_at > NOW() - INTERVAL '10 minutes') AS running
             FROM modules m
             JOIN module_configs c ON c.module_id = m.id
             WHERE m.enabled",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now();
    for row in rows {
        let module_id: String = row.get(0);
        let config: Value = row.get(1);
        let last_run: Option<chrono::DateTime<chrono::Utc>> = row.get(2);
        let running: bool = row.get(3);

        if running {
            continue;
        }
        let Some(raw_schedule) = config.get("schedule").and_then(|v| v.as_str()) else {
            continue;
        };
        let schedule = match parse_schedule(raw_schedule) {
            Ok(s) => s,
            Err(e) => {
                warn!("module {module_id}: {e} — skipping");
                continue;
            }
        };
        if !is_due(&schedule, last_run, now) {
            continue;
        }

        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = execute_module(&state, &module_id, "schedule").await {
                warn!("module {module_id}: scheduled run failed to start: {e}");
            }
        });
    }
    Ok(())
}
