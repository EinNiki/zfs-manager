//! Redis-backed cache for GitHub API responses.
//!
//! GitHub's unauthenticated rate limit is 60 requests/hour per IP.
//! All GitHub API calls in this codebase go through this cache so the
//! server makes at most one call per repo per TTL period (6 hours),
//! regardless of how many users or page reloads happen.

use redis::AsyncCommands;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::{debug, warn};

/// Cache TTL — how long a cached GitHub response is considered fresh.
pub const CACHE_TTL: u64 = 6 * 3600; // 6 hours

/// In-memory fallback when Redis is unavailable.
/// Key: "latest:{owner}/{repo}" or "releases:{owner}/{repo}"
static MEM_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, std::time::Instant)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn mem_fresh(key: &str) -> Option<String> {
    if let Ok(cache) = MEM_CACHE.lock() {
        if let Some((val, fetched_at)) = cache.get(key) {
            if fetched_at.elapsed().as_secs() < CACHE_TTL {
                return Some(val.clone());
            }
        }
    }
    None
}

fn mem_set(key: &str, val: &str) {
    if let Ok(mut cache) = MEM_CACHE.lock() {
        cache.insert(key.to_string(), (val.to_string(), std::time::Instant::now()));
    }
}

fn mem_invalidate(prefix: &str) {
    if let Ok(mut cache) = MEM_CACHE.lock() {
        cache.retain(|k, _| !k.starts_with(prefix));
    }
}

fn redis_key_latest(owner: &str, repo: &str) -> String {
    format!("github:latest:{owner}/{repo}")
}

fn redis_key_releases(owner: &str, repo: &str) -> String {
    format!("github:releases:{owner}/{repo}")
}

/// Parses owner and repo from a GitHub repository URL.
/// Returns `None` if the URL is not a valid GitHub repo URL.
pub fn parse_github_repo(url: &str) -> Option<(String, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.host_str() != Some("github.com") {
        return None;
    }
    let segments: Vec<&str> = parsed.path_segments().map(|c| c.collect()).unwrap_or_default();
    if segments.len() < 2 {
        return None;
    }
    let owner = segments[0].to_string();
    let repo = segments[1].trim_end_matches(".git").to_string();
    Some((owner, repo))
}

/// Fetches the latest release tag_name for a GitHub repo.
/// CACHE-ONLY: reads from Redis or in-memory cache. Never calls GitHub API
/// directly — the background scheduler populates the cache periodically.
/// Returns empty string if not cached.
pub async fn get_latest_release(
    redis: &Option<redis::aio::ConnectionManager>,
    repository_url: &str,
) -> String {
    let Some((owner, repo)) = parse_github_repo(repository_url) else {
        return String::new();
    };

    let rkey = redis_key_latest(&owner, &repo);
    let mkey = format!("latest:{owner}/{repo}");

    // 1. Check Redis
    if let Some(ref conn) = redis {
        let mut c = conn.clone();
        if let Ok(val) = c.get::<_, Option<String>>(&rkey).await {
            if let Some(v) = val {
                return v;
            }
        }
    }

    // 2. Check in-memory fallback
    if let Some(v) = mem_fresh(&mkey) {
        return v;
    }

    // Not cached — return empty. The scheduler will populate it.
    String::new()
}

/// Fetches all releases for a GitHub repo (for the version picker).
/// CACHE-ONLY: reads from Redis or in-memory cache. Never calls GitHub API
/// directly — the background scheduler populates the cache periodically.
/// Returns a Vec of release objects with tag_name, name, published_at, wasm_url.
pub async fn get_all_releases(
    redis: &Option<redis::aio::ConnectionManager>,
    repository_url: &str,
) -> Vec<Value> {
    let Some((owner, repo)) = parse_github_repo(repository_url) else {
        return Vec::new();
    };

    let rkey = redis_key_releases(&owner, &repo);
    let mkey = format!("releases:{owner}/{repo}");

    // 1. Check Redis
    if let Some(ref conn) = redis {
        let mut c = conn.clone();
        if let Ok(val) = c.get::<_, Option<String>>(&rkey).await {
            if let Some(v) = val {
                if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&v) {
                    return arr;
                }
            }
        }
    }

    // 2. Check in-memory fallback
    if let Some(v) = mem_fresh(&mkey) {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&v) {
            return arr;
        }
    }

    // Not cached — return empty. The scheduler will populate it.
    Vec::new()
}

/// Invalidates all cached GitHub data (both Redis and in-memory).
/// Called when the user clicks the Refresh button in the Store.
pub async fn invalidate_all(redis: &Option<redis::aio::ConnectionManager>) {
    // Redis: scan and delete all github:* keys
    if let Some(ref conn) = redis {
        let mut c = conn.clone();
        let mut cursor: u64 = 0;
        loop {
            let (next_cursor, keys): (u64, Vec<String>) =
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg("github:*")
                    .arg("COUNT")
                    .arg(100)
                    .query_async(&mut c)
                    .await
                    .unwrap_or((0, Vec::new()));
            if !keys.is_empty() {
                let _: redis::RedisResult<()> = c.del(&keys).await;
            }
            if next_cursor == 0 {
                break;
            }
            cursor = next_cursor;
        }
    }

    // In-memory: clear all
    mem_invalidate("latest:");
    mem_invalidate("releases:");
    debug!("github_cache: invalidated all caches");
}

/// Pre-warms the cache for a list of repository URLs.
/// Called by the background scheduler periodically.
/// This is the ONLY place that calls the GitHub API — all other code
/// paths read from cache only.
/// Re-indexes ALL releases from scratch (not incremental) so deleted
/// releases are removed from the cache.
pub async fn refresh_all(
    redis: &Option<redis::aio::ConnectionManager>,
    repo_urls: &[String],
) {
    let client = match reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!("github_cache: failed to build HTTP client: {e}");
            return;
        }
    };

    for url in repo_urls {
        let Some((owner, repo)) = parse_github_repo(url) else {
            continue;
        };

        // 1. Fetch latest release
        let latest_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
        match client.get(&latest_url).send().await {
            Ok(r) if r.status().is_success() => {
                let json: Value = r.json().await.unwrap_or(json!({}));
                let tag = json
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !tag.is_empty() {
                    let rkey = redis_key_latest(&owner, &repo);
                    let mkey = format!("latest:{owner}/{repo}");
                    if let Some(ref conn) = redis {
                        let mut c = conn.clone();
                        let _: redis::RedisResult<()> =
                            c.set_ex(&rkey, &tag, CACHE_TTL).await;
                    }
                    mem_set(&mkey, &tag);
                    debug!("github_cache: refreshed latest release for {owner}/{repo}: {tag}");
                }
            }
            _ => warn!("github_cache: failed to fetch latest release for {owner}/{repo}"),
        }

        // 2. Fetch ALL releases (full re-index, not incremental)
        let releases_url = format!("https://api.github.com/repos/{owner}/{repo}/releases");
        match client.get(&releases_url).send().await {
            Ok(r) if r.status().is_success() => {
                let releases_raw: Vec<Value> = r.json().await.unwrap_or_default();
                let releases: Vec<Value> = releases_raw
                    .iter()
                    .filter_map(|r| {
                        let tag_name = r.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
                        if tag_name.is_empty() {
                            return None;
                        }
                        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or(tag_name);
                        let published_at = r.get("published_at").and_then(|v| v.as_str()).unwrap_or("");
                        let assets = r.get("assets").and_then(|v| v.as_array());
                        let wasm_asset = assets.and_then(|arr| {
                            arr.iter().find(|a| {
                                a.get("name")
                                    .and_then(|n| n.as_str())
                                    .map(|n| n.ends_with(".wasm"))
                                    .unwrap_or(false)
                            })
                        });
                        let wasm_url = wasm_asset
                            .and_then(|a| a.get("browser_download_url"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        Some(json!({
                            "tag_name": tag_name,
                            "name": name,
                            "published_at": published_at,
                            "wasm_url": wasm_url,
                        }))
                    })
                    .collect();

                let serialized = serde_json::to_string(&releases).unwrap_or_default();
                let rkey = redis_key_releases(&owner, &repo);
                let mkey = format!("releases:{owner}/{repo}");
                if let Some(ref conn) = redis {
                    let mut c = conn.clone();
                    let _: redis::RedisResult<()> =
                        c.set_ex(&rkey, &serialized, CACHE_TTL).await;
                }
                mem_set(&mkey, &serialized);
                debug!("github_cache: refreshed {} releases for {owner}/{repo}", releases.len());
            }
            _ => warn!("github_cache: failed to fetch releases for {owner}/{repo}"),
        }
    }
    debug!("github_cache: background refresh complete for {} repos", repo_urls.len());
}
