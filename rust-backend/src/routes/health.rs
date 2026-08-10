use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::process::Command;

pub fn router() -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/health/latest-release", get(latest_release))
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

/// In-memory cache for the latest GitHub release tag.
/// GitHub's unauthenticated rate limit is 60 requests/hour per IP, so we
/// cache the result for 1 hour — regardless of how many users request it,
/// the server only hits GitHub once per hour.
static RELEASE_CACHE: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const RELEASE_CACHE_TTL: Duration = Duration::from_secs(3600);

async fn latest_release() -> Json<Value> {
    // Check cache first
    if let Ok(cache) = RELEASE_CACHE.lock() {
        if let Some((ref tag, ref fetched_at)) = *cache {
            if fetched_at.elapsed() < RELEASE_CACHE_TTL {
                return Json(json!({ "tag_name": tag }));
            }
        }
    }

    let client = match reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Json(json!({ "tag_name": "" })),
    };

    match client
        .get("https://api.github.com/repos/ZFS-Dashboard/ZFS-Dashboard/releases/latest")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let tag = json.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Ok(mut cache) = RELEASE_CACHE.lock() {
                *cache = Some((tag.clone(), Instant::now()));
            }
            Json(json!({ "tag_name": tag }))
        }
        _ => {
            // On failure, return the stale cache if available, otherwise empty
            if let Ok(cache) = RELEASE_CACHE.lock() {
                if let Some((ref tag, _)) = *cache {
                    return Json(json!({ "tag_name": tag }));
                }
            }
            Json(json!({ "tag_name": "" }))
        }
    }
}
