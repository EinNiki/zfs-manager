use serde_json::Value;
use std::time::Instant;
use tracing::{info, warn};

use super::github_cache;
use super::runner::{execute_module, is_due, parse_schedule};
use crate::state::AppState;

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const DEFAULT_GITHUB_REFRESH_HOURS: u64 = 6;

/// Reads the configured GitHub update interval from app_settings.
/// Returns hours. Default: 6. Minimum: 1. Maximum: 168 (1 week).
async fn get_github_refresh_interval_hours(state: &AppState) -> u64 {
    if let Some(pg) = state.pg.as_ref() {
        if let Ok(row) = pg
            .query_opt(
                "SELECT value FROM app_settings WHERE key = 'github_update_interval_hours'",
                &[],
            )
            .await
        {
            if let Some(row) = row {
                let val: Value = row.get(0);
                if let Some(n) = val.as_u64() {
                    return n.clamp(1, 168);
                }
                if let Some(n) = val.as_f64() {
                    return (n as u64).clamp(1, 168);
                }
            }
        }
    }
    DEFAULT_GITHUB_REFRESH_HOURS
}

/// Polls active module configs and triggers due runs. DB state is the single
/// source of truth, so config changes take effect on the next tick without
/// any registration bookkeeping.
///
/// Also refreshes the GitHub release cache periodically (configurable in
/// Settings → Security). The interval is re-read from the DB every tick
/// so changes take effect without restart.
pub async fn run_module_scheduler(state: AppState) {
    info!("Module scheduler started (tick {}s)", POLL_INTERVAL.as_secs());
    let mut last_github_refresh: Option<Instant> = None;
    let mut current_interval_secs: u64 = DEFAULT_GITHUB_REFRESH_HOURS * 3600;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        if let Err(e) = tick(&state).await {
            warn!("Module scheduler tick failed: {e}");
        }

        // Re-read interval from DB every tick (cheap query, every 30s)
        let new_hours = get_github_refresh_interval_hours(&state).await;
        let new_secs = new_hours * 3600;
        if new_secs != current_interval_secs {
            info!("GitHub refresh interval changed: {}h → {}h", current_interval_secs / 3600, new_hours);
            current_interval_secs = new_secs;
            // Force refresh on next check by resetting last_github_refresh
            last_github_refresh = None;
        }

        // Refresh GitHub cache if interval has elapsed
        let should_refresh = last_github_refresh
            .map(|t| t.elapsed().as_secs() >= current_interval_secs)
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
/// plus the ZFS-Dashboard repo itself. Also pre-warms the registry index
/// cache so the store listing is fast on first load.
async fn refresh_github_cache(state: &AppState) {
    use crate::modules::registry;

    let mut repo_urls = vec!["https://github.com/ZFS-Dashboard/ZFS-Dashboard".to_string()];

    // Collect all module repo URLs from all configured registries.
    // Use fetch_index (uncached) to force a fresh fetch every 6h, which
    // also updates the Redis cache for the next 5 minutes of store requests.
    if let Ok(registries) = crate::routes::module_store::configured_registries(state).await {
        for (_, url, _) in &registries {
            // fetch_index_cached will store the fresh index in Redis
            if let Ok(index) = registry::fetch_index_cached(url, &state.redis).await {
                for m in &index.modules {
                    if !repo_urls.contains(&m.repository_url) {
                        repo_urls.push(m.repository_url.clone());
                    }
                }
            }
        }
    }

    github_cache::refresh_all(&state.redis, &repo_urls).await;

    // Also invalidate and rebuild the store listing cache
    crate::routes::module_store::invalidate_store_cache(state).await;

    info!("GitHub cache + registry indexes refreshed ({} repos)", repo_urls.len());
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
