use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::manifest::{Manifest, MAX_MANIFEST_BYTES, MAX_WASM_BYTES};

use redis::AsyncCommands;

pub const DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/ZFS-Dashboard/ZFS-Dashboard/refs/heads/main/registry/index.json";

pub fn default_registry_url() -> String {
    let raw = match std::env::var("MODULE_REGISTRY_URL") {
        Ok(url) => url,
        Err(_) => DEFAULT_REGISTRY_URL.to_string(),
    };
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'').trim();
    if trimmed.is_empty() {
        DEFAULT_REGISTRY_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

const MAX_INDEX_BYTES: usize = 1024 * 1024;

/// One module as listed in a registry index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub repository_url: String,
    pub manifest_url: String,
    pub wasm_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryIndex {
    pub modules: Vec<RegistryEntry>,
}

fn registry_http() -> Result<reqwest::Client, String> {
    // Disable auto-redirect so we can preserve the Authorization header
    // across host changes (GitHub release assets redirect from github.com
    // to objects.githubusercontent.com, and reqwest strips auth headers
    // on cross-host redirects by default).
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// Rejects URLs whose host resolves to a private, loopback, or link-local
/// address. Guards against SSRF from a malicious/compromised registry index
/// pointing manifest_url/wasm_url at internal endpoints (e.g. cloud metadata).
async fn reject_internal_target(url: &reqwest::Url) -> Result<(), String> {
    use std::net::IpAddr;
    let host = url.host_str().ok_or("url has no host")?;
    let port = url.port_or_known_default().unwrap_or(443);

    let is_forbidden = |ip: &IpAddr| match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local()
                || v4.is_broadcast() || v4.is_unspecified() || v4.is_documentation()
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified() || v6.is_multicast(),
    };

    // Resolve at check time so DNS results are the ones we screen.
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("cannot resolve {host}: {e}"))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_forbidden(&addr.ip()) {
            return Err(format!("host {host} resolves to a non-public address"));
        }
    }
    if !any {
        return Err(format!("host {host} did not resolve"));
    }
    Ok(())
}

pub async fn fetch_capped(client: &reqwest::Client, url: &str, cap: usize) -> Result<Vec<u8>, String> {
    let auth = crate::modules::github_token::auth_header().await;
    let mut current_url = url.to_string();

    for _ in 0..6 {
        let parsed = reqwest::Url::parse(&current_url)
            .map_err(|e| format!("invalid url {current_url:?}: {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!("unsupported scheme in {current_url:?}"));
        }
        reject_internal_target(&parsed).await?;

        let mut request = client.get(parsed.as_str());
        // Add GitHub auth for github.com / raw.githubusercontent.com /
        // objects.githubusercontent.com (release asset CDN)
        let host = parsed.host_str().unwrap_or("");
        let is_github = host.ends_with("github.com") || host.ends_with("githubusercontent.com");
        if is_github {
            if let Some((ref k, ref v)) = auth {
                request = request.header(k, v);
            }
            // For GitHub API asset endpoints, need Accept: octet-stream
            if host == "api.github.com" {
                request = request.header("Accept", "application/octet-stream");
            }
        }

        let response = request
            .send()
            .await
            .map_err(|_| format!("fetch {current_url} failed: invalid registry URL or connection not possible"))?;

        if response.status().is_success() {
            let mut body = Vec::new();
            let mut response = response;
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                body.extend_from_slice(&chunk);
                if body.len() > cap {
                    return Err(format!("{current_url} exceeds {cap} bytes"));
                }
            }
            return Ok(body);
        } else if response.status().is_redirection() {
            // Follow redirect manually, preserving auth header on next hop
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .ok_or("redirect without location header")?;
            // Handle relative redirects
            if location.starts_with("http://") || location.starts_with("https://") {
                current_url = location;
            } else {
                current_url = parsed.join(&location)
                    .map(|u| u.to_string())
                    .unwrap_or(location);
            }
        } else if response.status().as_u16() == 404 {
            // For private repos, the github.com/.../releases/download/... URL
            // doesn't work with Bearer token auth. Fall back to the GitHub API
            // asset download, which does everything in one function (metadata
            // fetch + binary download) to avoid GitHub's secondary rate limit.
            let _ = response.text().await; // drain body
            tracing::info!("fetch_capped: got 404, trying GitHub API asset download fallback");
            if let Some(bytes) = crate::modules::github_cache::download_github_asset(url, &auth, cap).await {
                return Ok(bytes);
            }
            return Err(format!("fetch {url} failed: HTTP 404 and API asset download failed"));
        } else {
            return Err(format!("fetch {current_url} failed: HTTP {}", response.status()));
        }
    }
    Err("too many redirects".into())
}

/// Downloads and parses one registry index.
pub async fn fetch_index(url: &str) -> Result<RegistryIndex, String> {
    let client = registry_http()?;
    let body = fetch_capped(&client, url, MAX_INDEX_BYTES).await?;
    let index: RegistryIndex = serde_json::from_slice(&body)
        .map_err(|_| "Invalid registry URL: no valid index.json file detected".to_string())?;
    for entry in &index.modules {
        if entry.id.is_empty() {
            return Err(format!("registry entry {:?} is malformed", entry.id));
        }
    }
    Ok(index)
}

const REGISTRY_CACHE_TTL: u64 = 300; // 5 minutes

fn registry_cache_key(url: &str) -> String {
    use sha2::Digest;
    let hash = hex::encode(sha2::Sha256::digest(url.as_bytes()));
    format!("registry:index:{hash}")
}

/// Fetches a registry index with Redis caching (5 min TTL).
/// Falls back to direct fetch if Redis is unavailable.
pub async fn fetch_index_cached(
    url: &str,
    redis: &Option<redis::aio::ConnectionManager>,
) -> Result<RegistryIndex, String> {
    // Try Redis cache first
    if let Some(redis) = redis {
        let mut conn = redis.clone();
        let key = registry_cache_key(url);
        if let Ok(cached) = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            conn.get::<_, Option<String>>(&key),
        ).await {
            if let Ok(Some(json_str)) = cached {
                if let Ok(index) = serde_json::from_str::<RegistryIndex>(&json_str) {
                    return Ok(index);
                }
            }
        }
    }

    // Cache miss — fetch from network
    let index = fetch_index(url).await?;

    // Store in Redis (best-effort, don't fail if Redis is down)
    if let Some(redis) = redis {
        let mut conn = redis.clone();
        let key = registry_cache_key(url);
        if let Ok(json_str) = serde_json::to_string(&index) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(200),
                conn.set_ex::<_, _, ()>(&key, json_str, REGISTRY_CACHE_TTL),
            ).await;
        }
    }

    Ok(index)
}

/// Invalidates the cached registry index for a given URL.
pub async fn invalidate_index_cache(
    url: &str,
    redis: &Option<redis::aio::ConnectionManager>,
) {
    if let Some(redis) = redis {
        let mut conn = redis.clone();
        let key = registry_cache_key(url);
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            conn.del::<_, ()>(&key),
        ).await;
    }
}

/// Invalidates all cached registry indexes.
pub async fn invalidate_all_index_cache(
    redis: &Option<redis::aio::ConnectionManager>,
) {
    if let Some(redis) = redis {
        let mut conn = redis.clone();
        // Use SCAN to find and delete all registry:index:* keys
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            async {
                let keys: Vec<String> = redis::cmd("KEYS")
                    .arg("registry:index:*")
                    .query_async(&mut conn)
                    .await
                    .unwrap_or_default();
                if !keys.is_empty() {
                    let _: () = redis::cmd("DEL")
                        .arg(&keys)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or(());
                }
            },
        ).await;
    }
}

/// A fully downloaded module package.
pub struct ModulePackage {
    pub manifest: Manifest,
    pub wasm: Vec<u8>,
    pub wasm_sha256: String,
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Downloads manifest + wasm for a registry entry.
pub async fn download_package(entry: &RegistryEntry) -> Result<ModulePackage, String> {
    download_package_custom(entry, None, None).await
}

/// Downloads only the manifest (module.toml) for a registry entry, without the wasm.
/// Used during version switches to pick up new config_schema/widget_schema.
pub async fn fetch_manifest_only(entry: &RegistryEntry) -> Result<Manifest, String> {
    let client = registry_http()?;
    let manifest_bytes = fetch_capped(&client, &entry.manifest_url, MAX_MANIFEST_BYTES).await?;
    let manifest_toml = String::from_utf8(manifest_bytes).map_err(|_| "manifest is not UTF-8")?;
    Manifest::parse(&manifest_toml)
}

pub async fn download_package_custom(
    entry: &RegistryEntry,
    custom_version: Option<String>,
    custom_wasm_url: Option<String>,
) -> Result<ModulePackage, String> {
    let client = registry_http()?;

    let manifest_bytes = fetch_capped(&client, &entry.manifest_url, MAX_MANIFEST_BYTES).await?;
    let manifest_toml = String::from_utf8(manifest_bytes).map_err(|_| "manifest is not UTF-8")?;
    let mut manifest = Manifest::parse(&manifest_toml)?;
    if manifest.id != entry.id {
        return Err(format!(
            "manifest id {:?} does not match registry id {:?}",
            manifest.id, entry.id
        ));
    }

    let target_wasm_url = custom_wasm_url.as_ref().unwrap_or(&entry.wasm_url).clone();
    if let Some(v) = custom_version {
        manifest.version = v;
    } else if manifest.version.is_empty() {
        manifest.version = entry.version.clone();
    }

    let wasm = fetch_capped(&client, &target_wasm_url, MAX_WASM_BYTES).await?;
    let digest = sha256_hex(&wasm);

    Ok(ModulePackage {
        manifest,
        wasm,
        wasm_sha256: digest,
    })
}

/// Directory where installed wasm artifacts live.
pub fn modules_dir() -> String {
    format!("{}/modules", crate::startup::data_dir())
}

/// Builds the on-disk path for a module's wasm. Defensively rejects any id
/// that isn't the validated manifest charset, so a caller can never construct
/// a path-traversal path even if an unvalidated id slips through.
pub fn wasm_path(module_id: &str) -> Option<String> {
    let valid = !module_id.is_empty()
        && module_id.len() <= 64
        && module_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    valid.then(|| format!("{}/{module_id}.wasm", modules_dir()))
}
