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
/// Checks Redis cache first; on miss, calls GitHub API and caches the result.
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
                debug!("github_cache: Redis hit for {rkey}");
                return v;
            }
        }
    }

    // 2. Check in-memory fallback
    if let Some(v) = mem_fresh(&mkey) {
        debug!("github_cache: mem-cache hit for {mkey}");
        return v;
    }

    // 3. Fetch from GitHub API
    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let client = match reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    match client.get(&api_url).send().await {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let tag = json
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Cache in Redis + memory
            if let Some(ref conn) = redis {
                let mut c = conn.clone();
                let _: redis::RedisResult<()> =
                    c.set_ex(&rkey, &tag, CACHE_TTL).await;
            }
            mem_set(&mkey, &tag);
            debug!("github_cache: fetched and cached latest release for {owner}/{repo}: {tag}");
            tag
        }
        _ => {
            warn!("github_cache: failed to fetch latest release for {owner}/{repo}");
            String::new()
        }
    }
}

/// Fetches all releases for a GitHub repo (for the version picker).
/// Checks Redis cache first; on miss, calls GitHub API and caches the result.
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
                    debug!("github_cache: Redis hit for {rkey}");
                    return arr;
                }
            }
        }
    }

    // 2. Check in-memory fallback
    if let Some(v) = mem_fresh(&mkey) {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&v) {
            debug!("github_cache: mem-cache hit for {mkey}");
            return arr;
        }
    }

    // 3. Fetch from GitHub API
    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases");
    let client = match reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    match client.get(&api_url).send().await {
        Ok(r) if r.status().is_success() => {
            let releases_raw: Vec<Value> = r.json().await.unwrap_or_default();

            // Extract only the fields we need
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

            // Cache in Redis + memory
            let serialized = serde_json::to_string(&releases).unwrap_or_default();
            if let Some(ref conn) = redis {
                let mut c = conn.clone();
                let _: redis::RedisResult<()> =
                    c.set_ex(&rkey, &serialized, CACHE_TTL).await;
            }
            mem_set(&mkey, &serialized);
            debug!("github_cache: fetched and cached {} releases for {owner}/{repo}", releases.len());
            releases
        }
        _ => {
            warn!("github_cache: failed to fetch releases for {owner}/{repo}");
            Vec::new()
        }
    }
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
/// Called by the background scheduler every 6 hours.
pub async fn refresh_all(
    redis: &Option<redis::aio::ConnectionManager>,
    repo_urls: &[String],
) {
    for url in repo_urls {
        // Fetch both latest and all releases
        get_latest_release(redis, url).await;
        get_all_releases(redis, url).await;
    }
    debug!("github_cache: background refresh complete for {} repos", repo_urls.len());
}
