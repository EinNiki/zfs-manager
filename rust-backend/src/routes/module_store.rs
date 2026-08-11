use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::sync::RwLock;

use crate::error::ApiError;
use crate::modules::audit::{actor_from_headers, audit};
use crate::modules::github_cache;
use crate::modules::registry;
use crate::state::AppState;

use sha2::Digest;
use redis::AsyncCommands;

/// In-memory cache for configured registries — avoids DB query on every
/// store page load. Invalidated when registries are added/removed.
static REGISTRIES_MEM: LazyLock<RwLock<Option<Vec<(i32, String, bool)>>>> =
    LazyLock::new(|| RwLock::new(None));

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/modules/store", get(store_listing))
        .route("/api/v1/modules/store/refresh", post(refresh_store))
        .route("/api/v1/modules/releases", get(list_releases))
        .route(
            "/api/v1/modules/registries",
            get(list_registries).post(add_registry),
        )
        .route(
            "/api/v1/modules/registries/discover",
            post(discover_registry),
        )
        .route(
            "/api/v1/modules/registries/:id",
            axum::routing::delete(remove_registry),
        )
        .with_state(state)
}

/// Simple per-IP rate limit for module management endpoints (30/min).
pub fn mgmt_rate_limit(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("unknown").trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let key = format!("modules:{ip}");
    let mut map = state.rate_limit.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    let attempts = map.entry(key).or_default();
    attempts.retain(|t| now.duration_since(*t).as_secs() < 60);
    if attempts.len() >= 30 {
        return Err(ApiError::BadRequest(
            "Too many module management requests. Please wait.".into(),
        ));
    }
    attempts.push(now);
    Ok(())
}

pub async fn configured_registries(state: &AppState) -> Result<Vec<(i32, String, bool)>, ApiError> {
    // Try in-memory cache first (fastest — no IO)
    if let Some(cached) = REGISTRIES_MEM.read().await.as_ref() {
        return Ok(cached.clone());
    }

    // Try Redis cache (200ms timeout)
    let rkey = "registries:list";
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        if let Ok(cached) = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            conn.get::<_, Option<String>>(rkey),
        ).await {
            if let Ok(Some(json_str)) = cached {
                if let Ok(regs) = serde_json::from_str::<Vec<(i32, String, bool)>>(&json_str) {
                    // Populate in-memory cache
                    *REGISTRIES_MEM.write().await = Some(regs.clone());
                    return Ok(regs);
                }
            }
        }
    }

    // Cache miss — query DB
    let default_url = registry::default_registry_url();
    let mut registries = Vec::new();
    registries.push((0, default_url.clone(), true));

    if let Some(ref pg) = state.pg {
        let rows = pg
            .query("SELECT id, url FROM module_registries WHERE url <> $1 ORDER BY id", &[&default_url])
            .await
            .map_err(|e| ApiError::InternalError(e.to_string()))?;
        for r in rows {
            let id: i32 = r.get(0);
            let url: String = r.get(1);
            registries.push((id, url, false));
        }
    }

    // Cache in Redis (5 min TTL)
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        if let Ok(json_str) = serde_json::to_string(&registries) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                conn.set_ex::<_, _, ()>(rkey, json_str, 300),
            ).await;
        }
    }

    // Cache in memory
    *REGISTRIES_MEM.write().await = Some(registries.clone());

    Ok(registries)
}

/// Invalidates the registries cache (called when registries are added/removed).
pub async fn invalidate_registries_cache(state: &AppState) {
    *REGISTRIES_MEM.write().await = None;
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            conn.del::<_, ()>("registries:list"),
        ).await;
    }
}

const STORE_CACHE_TTL: u64 = 120; // 2 minutes

fn store_cache_key() -> &'static str {
    "store:listing"
}

async fn store_listing(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    // Try Redis cache for the full store listing first
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        if let Ok(cached) = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            conn.get::<_, Option<String>>(store_cache_key()),
        ).await {
            if let Ok(Some(json_str)) = cached {
                if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
                    return Ok(Json(val));
                }
            }
        }
    }

    let result = build_store_listing(&state).await?;

    // Cache the result in Redis (best-effort)
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        if let Ok(json_str) = serde_json::to_string(&result) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(200),
                conn.set_ex::<_, _, ()>(store_cache_key(), json_str, STORE_CACHE_TTL),
            ).await;
        }
    }

    Ok(Json(result))
}

async fn build_store_listing(state: &AppState) -> Result<Value, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    let installed_rows = pg
        .query("SELECT id, version FROM modules", &[])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let installed_map: std::collections::HashMap<String, String> = installed_rows
        .into_iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, String>(1)))
        .collect();

    let mut entries = Vec::new();
    let mut errors = Vec::new();
    for (_, url, _) in configured_registries(state).await? {
        // Use cached registry index (5 min TTL in Redis)
        match registry::fetch_index_cached(&url, &state.redis).await {
            Ok(index) => {
                // Fetch latest release versions from the Redis-backed cache.
                let mut join_set = tokio::task::JoinSet::new();
                for module in &index.modules {
                    let repo_url = module.repository_url.clone();
                    let redis = state.redis.clone();
                    join_set.spawn(async move {
                        github_cache::get_latest_release(&redis, &repo_url).await
                    });
                }
                let mut versions = Vec::with_capacity(index.modules.len());
                while let Some(res) = join_set.join_next().await {
                    versions.push(res.unwrap_or_default());
                }

                for (module, latest_version) in index.modules.into_iter().zip(versions) {
                    let inst_ver = installed_map.get(&module.id).cloned();
                    entries.push(json!({
                        "id": module.id,
                        "name": module.name,
                        "version": latest_version,
                        "author": module.author,
                        "description": module.description,
                        "icon": module.icon,
                        "repository_url": module.repository_url,
                        "registry_url": url,
                        "installed": inst_ver.is_some(),
                        "installed_version": inst_ver,
                    }));
                }
            }
            Err(e) => errors.push(json!({ "registry_url": url, "error": e })),
        }
    }
    Ok(json!({ "modules": entries, "errors": errors }))
}

/// Manual refresh: invalidates all caches, re-fetches everything,
/// then returns the fresh store listing.
async fn refresh_store(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;

    // Invalidate all cached data: GitHub cache, registry indexes, store listing
    github_cache::invalidate_all(&state.redis).await;
    registry::invalidate_all_index_cache(&state.redis).await;
    invalidate_store_cache(&state).await;

    // Re-fetch all registry indexes and pre-warm the GitHub cache
    let registries = configured_registries(&state).await?;
    let mut all_repo_urls = Vec::new();
    for (_, url, _) in &registries {
        if let Ok(index) = registry::fetch_index(&url).await {
            // Re-cache the fresh index
            if let Ok(json_str) = serde_json::to_string(&index) {
                if let Some(ref redis) = state.redis {
                    let mut conn = redis.clone();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(200),
                        conn.set_ex::<_, _, ()>(
                            &format!("registry:index:{}", hex::encode(sha2::Sha256::digest(url.as_bytes()))),
                            json_str,
                            300,
                        ),
                    ).await;
                }
            }
            for m in &index.modules {
                all_repo_urls.push(m.repository_url.clone());
            }
        }
    }
    let gh_errors = github_cache::refresh_all(&state.redis, &all_repo_urls).await;

    // Build and return the fresh store listing
    let mut result = build_store_listing(&state).await?;

    // Include GitHub API errors in the response so the frontend can show them
    if !gh_errors.is_empty() {
        if let Some(errors_arr) = result.get_mut("errors").and_then(|v| v.as_array_mut()) {
            for (url, err) in gh_errors {
                errors_arr.push(json!({ "registry_url": url, "error": err }));
            }
        }
    }

    // Cache the fresh result
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        if let Ok(json_str) = serde_json::to_string(&result) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(200),
                conn.set_ex::<_, _, ()>(store_cache_key(), json_str, STORE_CACHE_TTL),
            ).await;
        }
    }

    Ok(Json(result))
}

/// Invalidates the cached store listing.
pub async fn invalidate_store_cache(state: &AppState) {
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            conn.del::<_, ()>(store_cache_key()),
        ).await;
    }
}

/// Public alias for cross-module calls.
pub async fn invalidate_store_cache_pub(state: &AppState) {
    invalidate_store_cache(state).await;
}

async fn list_registries(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let registries: Vec<Value> = configured_registries(&state)
        .await?
        .into_iter()
        .map(|(id, url, is_default)| json!({ "id": id, "url": url, "is_default": is_default }))
        .collect();
    Ok(Json(json!({ "registries": registries })))
}

#[derive(Deserialize)]
struct DiscoverRegistryBody {
    url: String,
}

/// Given a URL (either a direct file URL or a repo URL), discovers candidate
/// index.json / registry.json files and returns all that are valid.
///
/// For a direct file URL (ends with .json), it just validates that one.
/// For a GitHub repo URL, it tries common locations on the `main` branch first.
/// Only if nothing is found on `main`, it falls back to `master`.
/// This avoids showing duplicate results when GitHub redirects non-existent
/// branches to the default branch.
///
/// Returns the found URLs along with their module data so the frontend
/// can do duplicate checking without making cross-origin requests.
async fn discover_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DiscoverRegistryBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let raw_input = body.url.trim().trim_end_matches('/').to_string();
    if raw_input.is_empty() {
        return Err(ApiError::BadRequest("URL is required".into()));
    }

    // If no scheme is given, try https:// first, then http://
    let input = if raw_input.starts_with("http://") || raw_input.starts_with("https://") {
        raw_input.clone()
    } else {
        format!("https://{raw_input}")
    };

    let parsed = match reqwest::Url::parse(&input) {
        Ok(u) => u,
        Err(_) => {
            // https failed to parse — try http
            let http_input = format!("http://{raw_input}");
            reqwest::Url::parse(&http_input)
                .map_err(|e| ApiError::BadRequest(format!("invalid url: {e}")))?
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest("url must be http(s)".into()));
    }

    let client = reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    // For GitHub repos, try main first, then master as fallback.
    // For direct .json URLs and generic URLs, try all candidates at once.
    let github_repo = if parsed.host_str() == Some("github.com") {
        let segments: Vec<&str> = parsed.path_segments().map(|c| c.collect()).unwrap_or_default();
        if segments.len() >= 2 {
            Some((segments[0], segments[1].trim_end_matches(".git")))
        } else {
            None
        }
    } else {
        None
    };

    let mut found: Vec<Value> = Vec::new();
    let mut found_invalid: Vec<String> = Vec::new();
    let mut candidates_checked = 0;

    if let Some((owner, repo)) = github_repo {
        if input.to_lowercase().ends_with(".json") {
            // Direct .json URL on github.com — just check it
            let candidates = vec![input.clone()];
            candidates_checked += candidates.len();
            fetch_candidates(&client, &candidates, &mut found, &mut found_invalid).await;
        } else {
            // Try main branch first
            let paths = ["index.json", "registry/index.json", "registry.json"];
            let main_urls: Vec<String> = paths
                .iter()
                .map(|p| format!("https://raw.githubusercontent.com/{owner}/{repo}/main/{p}"))
                .collect();
            candidates_checked += main_urls.len();
            fetch_candidates(&client, &main_urls, &mut found, &mut found_invalid).await;

            // Only try master if nothing was found on main
            if found.is_empty() {
                let master_urls: Vec<String> = paths
                    .iter()
                    .map(|p| format!("https://raw.githubusercontent.com/{owner}/{repo}/master/{p}"))
                    .collect();
                candidates_checked += master_urls.len();
                fetch_candidates(&client, &master_urls, &mut found, &mut found_invalid).await;
            }
        }
    } else {
        // Non-GitHub URL
        let candidates = build_candidate_urls(&input, &parsed);
        candidates_checked += candidates.len();
        fetch_candidates(&client, &candidates, &mut found, &mut found_invalid).await;
    }

    // Sort for stable ordering
    found.sort_by_key(|f| f["url"].as_str().unwrap_or("").to_string());
    found_invalid.sort();

    Ok(Json(json!({
        "input": input,
        "candidates_checked": candidates_checked,
        "found": found,
        "invalid": found_invalid,
    })))
}

/// Fetches a batch of candidate URLs in parallel and appends results to
/// the `found` and `found_invalid` vectors.
async fn fetch_candidates(
    client: &reqwest::Client,
    urls: &[String],
    found: &mut Vec<Value>,
    found_invalid: &mut Vec<String>,
) {
    let mut join_set = tokio::task::JoinSet::new();
    for url in urls {
        let url = url.clone();
        let client = client.clone();
        join_set.spawn(async move {
            let resp = client.get(&url).send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let text = r.text().await.unwrap_or_default();
                    match serde_json::from_str::<Value>(&text) {
                        Ok(v) if v.get("modules").and_then(|m| m.as_array()).is_some() => {
                            Some((url, true, v))
                        }
                        _ => Some((url, false, Value::Null)),
                    }
                }
                _ => Some((url, false, Value::Null)),
            }
        });
    }

    while let Some(res) = join_set.join_next().await {
        if let Ok(Some((url, is_valid, data))) = res {
            if is_valid {
                let modules = data.get("modules").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                found.push(json!({
                    "url": url,
                    "modules": modules,
                }));
            } else {
                found_invalid.push(url);
            }
        }
    }
}

/// Builds a list of candidate index file URLs for non-GitHub URLs.
/// GitHub URLs are handled directly in `discover_registry` with branch fallback.
fn build_candidate_urls(input: &str, _parsed: &reqwest::Url) -> Vec<String> {
    // If the URL already points to a .json file, just use it directly
    if input.to_lowercase().ends_with(".json") {
        return vec![input.to_string()];
    }

    // Generic URL → try appending common paths
    vec![
        format!("{input}/index.json"),
        format!("{input}/registry/index.json"),
        format!("{input}/registry.json"),
    ]
}

#[derive(Deserialize)]
struct AddRegistryBody {
    url: String,
}

async fn add_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AddRegistryBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let raw_url = body.url.trim().trim_matches('"').trim_matches('\'').trim().to_string();
    // If no scheme is given, prepend https://
    let url = if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
        raw_url
    } else {
        format!("https://{raw_url}")
    };
    let default_url = registry::default_registry_url();
    if url == default_url {
        return Err(ApiError::BadRequest("This URL is already active as the default registry".into()));
    }
    let parsed = reqwest::Url::parse(&url)
        .map_err(|e| ApiError::BadRequest(format!("invalid registry url: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest("registry url must be http(s)".into()));
    }
    // Must be a fetchable, valid index before it is accepted.
    registry::fetch_index(&url)
        .await
        .map_err(|e| ApiError::BadRequest(format!("registry index check failed: {e}")))?;

    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    let row = pg
        .query_one(
            "INSERT INTO module_registries(url, is_default) VALUES($1, FALSE)
             ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url RETURNING id",
            &[&url],
        )
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let id: i32 = row.get(0);

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "registry_added", None, json!({ "url": url })).await;

    // Invalidate caches so the new registry shows up immediately
    invalidate_store_cache(&state).await;
    invalidate_registries_cache(&state).await;

    Ok(Json(json!({ "id": id, "url": url })))
}

async fn remove_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    if id == 0 {
        return Err(ApiError::BadRequest("Cannot remove the default registry".into()));
    }
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    let row = pg
        .query_opt("DELETE FROM module_registries WHERE id = $1 RETURNING url", &[&id])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let Some(row) = row else {
        return Err(ApiError::BadRequest("registry not found".into()));
    };
    let url: String = row.get(0);

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "registry_removed", None, json!({ "url": url })).await;

    // Invalidate caches so the removed registry disappears immediately
    registry::invalidate_index_cache(&url, &state.redis).await;
    invalidate_store_cache(&state).await;
    invalidate_registries_cache(&state).await;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ReleasesQuery {
    repository_url: String,
}

async fn list_releases(
    State(state): State<AppState>,
    Query(q): Query<ReleasesQuery>,
) -> Result<Json<Value>, ApiError> {
    // All GitHub API calls go through the Redis-backed cache.
    // No direct GitHub API call here — the cache is populated by the
    // background scheduler (every 6h) or the manual Refresh button.
    let releases = github_cache::get_all_releases(&state.redis, &q.repository_url).await;
    Ok(Json(json!({ "releases": releases })))
}
