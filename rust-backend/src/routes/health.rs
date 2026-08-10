use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/health/latest-release", get(latest_release))
        .with_state(state)
}

async fn run_git_cmd(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

async fn health() -> Json<Value> {
    // 1. Local commit hash and short hash
    let local_hash = run_git_cmd(&["rev-parse", "HEAD"]).await;
    let local_short = run_git_cmd(&["rev-parse", "--short", "HEAD"]).await;
    
    // 2. Local branch name
    let branch = run_git_cmd(&["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap_or_else(|| "main".to_string());
    
    // 3. Remote Origin URL (the user's fork!)
    let fork_url = run_git_cmd(&["config", "--get", "remote.origin.url"]).await;
    
    // 4. Remote commit hash on their fork
    let mut remote_hash = None;
    if let Some(ref _url) = fork_url {
        remote_hash = run_git_cmd(&["ls-remote", "origin", &format!("refs/heads/{}", branch)])
            .await
            .and_then(|output| {
                output.split_whitespace().next().map(|s| s.to_string())
            });
    }

    // 5. Upstream commit hash (original repository)
    let upstream_hash = run_git_cmd(&["ls-remote", "https://github.com/ZFS-Dashboard/ZFS-Dashboard.git", "refs/heads/main"])
        .await
        .and_then(|output| {
            output.split_whitespace().next().map(|s| s.to_string())
        });

    // 6. Check if up-to-date with fork and upstream
    let mut status = "unknown".to_string();
    let mut upstream_status = "unknown".to_string();

    if let (Some(ref l), Some(ref r)) = (&local_hash, &remote_hash) {
        if l == r {
            status = "up-to-date".to_string();
        } else {
            status = "out-of-date".to_string();
        }
    }

    if let (Some(ref l), Some(ref u)) = (&local_hash, &upstream_hash) {
        if l == u {
            upstream_status = "up-to-date".to_string();
        } else {
            upstream_status = "out-of-date".to_string();
        }
    }

    Json(json!({
        "status": "ok",
        "service": "zfs-dashboard",
        "version": env!("CARGO_PKG_VERSION"),
        "git": {
            "local_hash": local_hash,
            "local_short": local_short,
            "branch": branch,
            "fork_url": fork_url,
            "remote_hash": remote_hash,
            "upstream_hash": upstream_hash,
            "status": status,
            "upstream_status": upstream_status,
        }
    }))
}

/// Returns the latest GitHub release tag for the ZFS-Dashboard repo.
/// Uses the same Redis-backed cache as the module store — no direct
/// GitHub API call on every request. The cache is refreshed every 6h
/// by the background scheduler or when the Store Refresh button is clicked.
async fn latest_release(
    State(state): State<AppState>,
) -> Json<Value> {
    let tag = crate::modules::github_cache::get_latest_release(
        &state.redis,
        "https://github.com/ZFS-Dashboard/ZFS-Dashboard",
    )
    .await;
    Json(json!({ "tag_name": tag }))
}
