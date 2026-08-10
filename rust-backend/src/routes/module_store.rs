use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::modules::audit::{actor_from_headers, audit};
use crate::modules::registry;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/modules/store", get(store_listing))
        .route("/api/v1/modules/releases", get(list_releases))
        .route(
            "/api/v1/modules/registries",
            get(list_registries).post(add_registry),
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
    let mut registries = Vec::new();
    let default_url = registry::default_registry_url();
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
    Ok(registries)
}

/// Fetches the latest release tag from GitHub's releases/latest API.
/// Returns an empty string on any failure (non-GitHub URL, network error, etc.).
async fn fetch_latest_release_version(repository_url: &str) -> String {
    let parsed = match reqwest::Url::parse(repository_url) {
        Ok(u) => u,
        Err(_) => return String::new(),
    };
    if parsed.host_str() != Some("github.com") {
        return String::new();
    }
    let path_segments: Vec<&str> = parsed.path_segments().map(|c| c.collect()).unwrap_or_default();
    if path_segments.len() < 2 {
        return String::new();
    }
    let owner = path_segments[0];
    let repo = path_segments[1].trim_end_matches(".git");

    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let client = match reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    match client.get(&api_url).send().await {
        Ok(r) if r.status().is_success() => {
            let json: Value = match r.json().await {
                Ok(j) => j,
                Err(_) => return String::new(),
            };
            json.get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        _ => String::new(),
    }
}

async fn store_listing(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
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
    for (_, url, _) in configured_registries(&state).await? {
        match registry::fetch_index(&url).await {
            Ok(index) => {
                // Fetch latest release versions from GitHub in parallel so the
                // store listing reflects real upstream versions without needing
                // a manually-maintained "version" field in index.json.
                let repo_urls: Vec<String> = index
                    .modules
                    .iter()
                    .map(|m| m.repository_url.clone())
                    .collect();
                let module_count = index.modules.len();
                let mut join_set = tokio::task::JoinSet::new();
                for repo_url in repo_urls {
                    join_set.spawn(async move {
                        fetch_latest_release_version(&repo_url).await
                    });
                }
                let mut versions = Vec::with_capacity(module_count);
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
    Ok(Json(json!({ "modules": entries, "errors": errors })))
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
struct AddRegistryBody {
    url: String,
}

async fn add_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AddRegistryBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let url = body.url.trim().trim_matches('"').trim_matches('\'').trim().to_string();
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
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ReleasesQuery {
    repository_url: String,
}

async fn list_releases(Query(q): Query<ReleasesQuery>) -> Result<Json<Value>, ApiError> {
    let repo_url = q.repository_url.trim();
    let parsed = reqwest::Url::parse(repo_url)
        .map_err(|e| ApiError::BadRequest(format!("invalid repository url: {e}")))?;
    if parsed.host_str() != Some("github.com") {
        return Err(ApiError::BadRequest("releases fetch only supported for github.com repositories".into()));
    }
    let path_segments: Vec<&str> = parsed.path_segments().map(|c| c.collect()).unwrap_or_default();
    if path_segments.len() < 2 {
        return Err(ApiError::BadRequest("invalid github repository path".into()));
    }
    let owner = path_segments[0];
    let repo = path_segments[1].trim_end_matches(".git");

    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases");
    let client = reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    let resp = client.get(&api_url).send().await;
    let releases_json: Vec<Value> = match resp {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        _ => Vec::new(),
    };

    let mut releases = Vec::new();
    for r in releases_json {
        let tag_name = r.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or(tag_name);
        let published_at = r.get("published_at").and_then(|v| v.as_str()).unwrap_or("");
        
        let assets = r.get("assets").and_then(|v| v.as_array());
        let wasm_asset = assets.and_then(|arr| {
            arr.iter().find(|a| {
                a.get("name").and_then(|n| n.as_str()).map(|n| n.ends_with(".wasm")).unwrap_or(false)
            })
        });

        let wasm_url = wasm_asset
            .and_then(|a| a.get("browser_download_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if !tag_name.is_empty() {
            releases.push(json!({
                "tag_name": tag_name,
                "name": name,
                "published_at": published_at,
                "wasm_url": wasm_url,
            }));
        }
    }

    Ok(Json(json!({ "releases": releases })))
}
