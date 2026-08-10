use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::manifest::{Manifest, MAX_MANIFEST_BYTES, MAX_WASM_BYTES};

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
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
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

async fn fetch_capped(client: &reqwest::Client, url: &str, cap: usize) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url {url:?}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme in {url:?}"));
    }
    reject_internal_target(&parsed).await?;
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| format!("fetch {url} failed: Ungültige Registry-URL oder keine Verbindung möglich"))?
        .error_for_status()
        .map_err(|_| format!("fetch {url} failed: Ungültige Registry-URL oder keine gültige index.json Datei erkannt (HTTP-Fehler)"))?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > cap {
            return Err(format!("{url} exceeds {cap} bytes"));
        }
    }
    Ok(body)
}

/// Downloads and parses one registry index.
pub async fn fetch_index(url: &str) -> Result<RegistryIndex, String> {
    let client = registry_http()?;
    let body = fetch_capped(&client, url, MAX_INDEX_BYTES).await?;
    let index: RegistryIndex = serde_json::from_slice(&body)
        .map_err(|_| "Ungültige Registry-URL: Keine gültige index.json Datei erkannt".to_string())?;
    for entry in &index.modules {
        if entry.id.is_empty() {
            return Err(format!("registry entry {:?} is malformed", entry.id));
        }
    }
    Ok(index)
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
