use std::collections::HashMap;

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    routing::{get, post, put},
    Json, Router,
};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use super::module_store::mgmt_rate_limit;
use crate::error::ApiError;
use crate::modules::audit::{actor_from_headers, audit};
use crate::modules::manifest::{Manifest, MAX_WASM_BYTES};
use crate::modules::registry;
use crate::modules::runner::{execute_module, parse_schedule};
use crate::modules::secrets;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/modules/install", post(install_from_registry))
        .route("/api/v1/modules/sideload", post(sideload))
        .route("/api/v1/modules/active", get(list_active))
        .route("/api/v1/modules/:id", axum::routing::delete(uninstall))
        .route("/api/v1/modules/:id/config", put(update_config))
        .route("/api/v1/modules/:id/database", get(get_module_database).put(update_module_database))
        .route("/api/v1/modules/:id/database/test", post(test_module_database))
        .route("/api/v1/modules/:id/enable", post(enable))
        .route("/api/v1/modules/:id/disable", post(disable))
        .route("/api/v1/modules/:id/run", post(trigger_run))
        .route("/api/v1/modules/:id/runs", get(run_history))
        .route("/api/v1/modules/:id/switch-version", post(switch_version))
        .route("/api/v1/modules/:id/metrics", post(push_metrics).get(get_module_metrics))
        .route("/api/v1/modules/:id/action/:action_key", post(trigger_action))
        // Sideload payloads carry a base64 wasm artifact (up to 32 MiB raw).
        .layer(DefaultBodyLimit::max(48 * 1024 * 1024))
        .with_state(state)
}

fn db(state: &AppState) -> Result<&std::sync::Arc<tokio_postgres::Client>, ApiError> {
    state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))
}

/// Persists a validated package: wasm to disk, module + empty config to DB.
async fn register_module(
    state: &AppState,
    package: registry::ModulePackage,
    source: &str,
    registry_url: Option<&str>,
) -> Result<(), ApiError> {
    let runtime = state
        .module_runtime
        .as_ref()
        .ok_or(ApiError::InternalError("module runtime unavailable".into()))?;
    runtime
        .validate_component(&package.wasm)
        .map_err(ApiError::BadRequest)?;

    tokio::fs::create_dir_all(registry::modules_dir())
        .await
        .map_err(|e| ApiError::InternalError(format!("cannot create modules dir: {e}")))?;
    let wasm_path = registry::wasm_path(&package.manifest.id)
        .ok_or(ApiError::BadRequest("invalid module id".into()))?;
    tokio::fs::write(&wasm_path, &package.wasm)
        .await
        .map_err(|e| ApiError::InternalError(format!("cannot store wasm: {e}")))?;

    let manifest_json = serde_json::to_value(&package.manifest)
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let m = &package.manifest;
    let pg = db(state)?;
    pg.execute(
        "INSERT INTO modules(id, name, version, author, description, icon, repository_url, source, registry_url, wasm_sha256, manifest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, version = EXCLUDED.version, author = EXCLUDED.author,
             description = EXCLUDED.description, icon = EXCLUDED.icon,
             repository_url = EXCLUDED.repository_url, source = EXCLUDED.source,
             registry_url = EXCLUDED.registry_url, wasm_sha256 = EXCLUDED.wasm_sha256,
             manifest = EXCLUDED.manifest",
        &[
            &m.id, &m.name, &m.version, &m.author, &m.description, &m.icon,
            &m.repository_url, &source, &registry_url, &package.wasm_sha256, &manifest_json,
        ],
    )
    .await
    .map_err(|e| ApiError::InternalError(e.to_string()))?;
    pg.execute(
        "INSERT INTO module_configs(module_id) VALUES($1) ON CONFLICT DO NOTHING",
        &[&m.id],
    )
    .await
    .map_err(|e| ApiError::InternalError(e.to_string()))?;
    Ok(())
}

#[derive(Deserialize)]
struct InstallBody {
    registry_url: String,
    id: String,
    version: Option<String>,
    wasm_url: Option<String>,
}

async fn install_from_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<InstallBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    // Only registries the user has configured are valid install sources.
    let known = super::module_store::configured_registries(&state)
        .await?
        .into_iter()
        .any(|(_, url, _)| url == body.registry_url);
    if !known {
        return Err(ApiError::BadRequest("unknown registry".into()));
    }

    let index = registry::fetch_index(&body.registry_url)
        .await
        .map_err(ApiError::BadRequest)?;
    let entry = index
        .modules
        .iter()
        .find(|m| m.id == body.id)
        .ok_or_else(|| ApiError::NotFound(format!("module {:?} not in registry", body.id)))?;
    let package = registry::download_package_custom(entry, body.version, body.wasm_url)
        .await
        .map_err(ApiError::BadRequest)?;

    let module_id = package.manifest.id.clone();
    let version = package.manifest.version.clone();
    register_module(&state, package, "registry", Some(&body.registry_url)).await?;

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_installed", Some(&module_id),
          json!({ "version": version, "registry_url": body.registry_url })).await;
    Ok(Json(json!({ "id": module_id, "version": version })))
}

#[derive(Deserialize)]
struct SideloadBody {
    manifest_toml: String,
    wasm_base64: String,
}

async fn sideload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SideloadBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let manifest = Manifest::parse(&body.manifest_toml).map_err(ApiError::BadRequest)?;
    let wasm = base64::engine::general_purpose::STANDARD
        .decode(body.wasm_base64.as_bytes())
        .map_err(|e| ApiError::BadRequest(format!("invalid wasm_base64: {e}")))?;
    if wasm.len() > MAX_WASM_BYTES {
        return Err(ApiError::BadRequest(format!("wasm exceeds {MAX_WASM_BYTES} bytes")));
    }

    let module_id = manifest.id.clone();
    let version = manifest.version.clone();
    let package = registry::ModulePackage {
        wasm_sha256: registry::sha256_hex(&wasm),
        manifest,
        wasm,
    };
    register_module(&state, package, "sideload", None).await?;

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_sideloaded", Some(&module_id), json!({ "version": version })).await;
    Ok(Json(json!({ "id": module_id, "version": version })))
}

fn format_metric_label(name: &str) -> String {
    let clean = name.replace('_', " ").replace('.', " ");
    let mut c = clean.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

async fn list_active(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let pg = db(&state)?;
    let rows = pg
        .query(
            "SELECT m.id, m.name, m.version, m.author, m.description, m.icon,
                    m.repository_url, m.source, m.registry_url, m.enabled,
                    m.installed_at, m.manifest, c.config, c.secrets,
                    r.started_at, r.finished_at, r.success, r.message
             FROM modules m
             LEFT JOIN module_configs c ON c.module_id = m.id
             LEFT JOIN LATERAL (
                 SELECT started_at, finished_at, success, message
                 FROM module_runs WHERE module_id = m.id
                 ORDER BY started_at DESC LIMIT 1
             ) r ON TRUE
             ORDER BY m.installed_at",
            &[],
        )
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    // Generic metric auto-discovery for all modules from module_metrics table
    let metric_rows = pg
        .query("SELECT DISTINCT module_id, metric_name FROM module_metrics", &[])
        .await
        .unwrap_or_default();

    let mut collected_metrics_by_mod: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for r in metric_rows {
        let mod_id: String = r.get(0);
        let metric_name: String = r.get(1);
        collected_metrics_by_mod.entry(mod_id).or_default().push(metric_name);
    }

    let master_key = state.master_key;
    let modules: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mod_id: String = row.get(0);
            let manifest: Value = row.get(11);
            let secrets_blob: Option<Vec<u8>> = row.get(13);
            // Never return secret values — only which keys are set.
            let secret_keys_set: Vec<String> = match (master_key, secrets_blob) {
                (Some(key), Some(blob)) => secrets::decrypt_secrets(&key, &blob)
                    .map(|m| m.keys().cloned().collect())
                    .unwrap_or_default(),
                _ => Vec::new(),
            };

            let mut widget_schema: Vec<Value> = manifest
                .get("widget_schema")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            // Auto-discover widgets for any metrics pushed to module_metrics not explicitly in widget_schema
            if let Some(metrics) = collected_metrics_by_mod.get(&mod_id) {
                for m_name in metrics {
                    let exists = widget_schema.iter().any(|w| {
                        w.get("key").and_then(|k| k.as_str()) == Some(m_name.as_str())
                            || w.get("metrics")
                                .and_then(|arr| arr.as_array())
                                .map(|arr| arr.iter().any(|item| item.as_str() == Some(m_name.as_str())))
                                .unwrap_or(false)
                    });

                    if !exists {
                        let label = format_metric_label(m_name);
                        let unit = if m_name.contains("bytes") || m_name.contains("usage") || m_name.contains("disk") || m_name.contains("size") {
                            "bytes"
                        } else if m_name.contains("pct") || m_name.contains("percent") {
                            "%"
                        } else if m_name.contains("ms") {
                            "ms"
                        } else {
                            ""
                        };
                        let widget_type = if m_name.contains("users") || m_name.contains("count") || m_name.contains("total") || m_name.contains("num") || m_name.contains("photos") || m_name.contains("videos") {
                            "stat"
                        } else {
                            "line"
                        };

                        widget_schema.push(json!({
                            "key": m_name,
                            "label": label,
                            "type": widget_type,
                            "metrics": [m_name],
                            "unit": unit,
                            "color": "var(--accent)",
                            "description": format!("Metric: {m_name}"),
                        }));
                    }
                }
            }

            json!({
                "id": mod_id,
                "name": row.get::<_, String>(1),
                "version": row.get::<_, String>(2),
                "author": row.get::<_, String>(3),
                "description": row.get::<_, String>(4),
                "icon": row.get::<_, String>(5),
                "repository_url": row.get::<_, String>(6),
                "source": row.get::<_, String>(7),
                "registry_url": row.get::<_, Option<String>>(8),
                "enabled": row.get::<_, bool>(9),
                "installed_at": row.get::<_, chrono::DateTime<chrono::Utc>>(10),
                "config_schema": manifest.get("config_schema").cloned().unwrap_or(json!([])),
                "widget_schema": widget_schema,
                "status_fields": manifest.get("status_fields").cloned().unwrap_or(json!([])),
                "actions": manifest.get("actions").cloned().unwrap_or(json!([])),
                "config": row.get::<_, Option<Value>>(12).unwrap_or(json!({})),
                "secret_keys_set": secret_keys_set,
                "last_run": row.get::<_, Option<chrono::DateTime<chrono::Utc>>>(14).map(|started| json!({
                    "started_at": started,
                    "finished_at": row.get::<_, Option<chrono::DateTime<chrono::Utc>>>(15),
                    "success": row.get::<_, Option<bool>>(16),
                    "message": row.get::<_, Option<String>>(17),
                })),
            })
        })
        .collect();
    Ok(Json(json!({ "modules": modules })))
}

async fn uninstall(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let pg = db(&state)?;

    // Delete data that has no FK cascade (module_id is plain TEXT, not REFERENCES).
    let _ = pg.execute("DELETE FROM module_metrics WHERE module_id = $1", &[&id]).await;
    let _ = pg.execute("DELETE FROM module_audit_log WHERE module_id = $1", &[&id]).await;

    // Remove stale widget placements from all custom tabs.
    // The layout column is a JSONB array of objects with a `module_id` field.
    let rows = pg
        .query("SELECT id, layout FROM custom_tabs", &[])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    for row in &rows {
        let tab_id: i32 = row.get(0);
        let layout: Value = row.get(1);
        if let Some(arr) = layout.as_array() {
            let filtered: Vec<&Value> = arr
                .iter()
                .filter(|item| item.get("module_id").and_then(|v| v.as_str()) != Some(&id))
                .collect();
            if filtered.len() != arr.len() {
                let new_layout = Value::Array(filtered.into_iter().cloned().collect());
                let _ = pg
                    .execute(
                        "UPDATE custom_tabs SET layout = $1 WHERE id = $2",
                        &[&new_layout, &tab_id],
                    )
                    .await;
            }
        }
    }

    let deleted = pg
        .execute("DELETE FROM modules WHERE id = $1", &[&id])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    if deleted == 0 {
        return Err(ApiError::NotFound(format!("module {id:?} not installed")));
    }
    if let Some(path) = registry::wasm_path(&id) {
        let _ = tokio::fs::remove_file(path).await;
    }
    // Drop the per-module database selection as well.
    let _ = pg
        .execute("DELETE FROM app_settings WHERE key = $1", &[&module_db_key(&id)])
        .await;

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_uninstalled", Some(&id), json!({})).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ConfigBody {
    #[serde(default)]
    config: serde_json::Map<String, Value>,
    /// Secret updates: value = set/replace, null = remove.
    #[serde(default)]
    secrets: HashMap<String, Option<String>>,
}

async fn update_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ConfigBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let pg = db(&state)?;
    let row = pg
        .query_opt("SELECT manifest, (SELECT secrets FROM module_configs WHERE module_id = id) FROM modules WHERE id = $1", &[&id])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("module {id:?} not installed")))?;
    let manifest: Manifest = serde_json::from_value(row.get(0))
        .map_err(|e| ApiError::InternalError(format!("stored manifest invalid: {e}")))?;

    // Config keys must exist in the schema (secrets go through `secrets`).
    let allowed: Vec<&str> = manifest
        .config_schema
        .iter()
        .filter(|f| f.field_type != "secret")
        .map(|f| f.key.as_str())
        .collect();
    for key in body.config.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ApiError::BadRequest(format!("unknown config key {key:?}")));
        }
    }
    if let Some(schedule) = body.config.get("schedule").and_then(|v| v.as_str()) {
        parse_schedule(schedule).map_err(ApiError::BadRequest)?;
    }

    let secret_keys = manifest.secret_keys();
    for key in body.secrets.keys() {
        if !secret_keys.contains(&key.as_str()) {
            return Err(ApiError::BadRequest(format!("unknown secret key {key:?}")));
        }
    }

    let secrets_blob = if body.secrets.is_empty() {
        row.get::<_, Option<Vec<u8>>>(1)
    } else {
        let master_key = state
            .master_key
            .ok_or(ApiError::InternalError("secrets master key unavailable".into()))?;
        let mut current = match row.get::<_, Option<Vec<u8>>>(1) {
            Some(blob) => secrets::decrypt_secrets(&master_key, &blob)
                .map_err(ApiError::InternalError)?,
            None => HashMap::new(),
        };
        for (key, value) in body.secrets {
            match value {
                Some(v) => { current.insert(key, v); }
                None => { current.remove(&key); }
            }
        }
        Some(secrets::encrypt_secrets(&master_key, &current).map_err(ApiError::InternalError)?)
    };

    let config_value = Value::Object(body.config);
    pg.execute(
        "INSERT INTO module_configs(module_id, config, secrets, updated_at) VALUES($1, $2, $3, NOW())
         ON CONFLICT (module_id) DO UPDATE SET config = $2, secrets = $3, updated_at = NOW()",
        &[&id, &config_value, &secrets_blob],
    )
    .await
    .map_err(|e| ApiError::InternalError(e.to_string()))?;

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_config_updated", Some(&id), json!({})).await;
    Ok(Json(json!({ "ok": true })))
}

async fn set_enabled(state: &AppState, headers: &HeaderMap, id: &str, enabled: bool) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(state, headers)?;
    let pg = db(state)?;
    let updated = pg
        .execute("UPDATE modules SET enabled = $1 WHERE id = $2", &[&enabled, &id])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    if updated == 0 {
        return Err(ApiError::NotFound(format!("module {id:?} not installed")));
    }
    let actor = actor_from_headers(state, headers).await;
    let action = if enabled { "module_enabled" } else { "module_disabled" };
    audit(state, &actor, action, Some(id), json!({})).await;
    Ok(Json(json!({ "ok": true, "enabled": enabled })))
}

async fn enable(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    set_enabled(&state, &headers, &id, true).await
}

async fn disable(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    set_enabled(&state, &headers, &id, false).await
}

async fn trigger_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_run_triggered", Some(&id), json!({})).await;

    let (run_id, outcome) = execute_module(&state, &id, "manual")
        .await
        .map_err(ApiError::BadRequest)?;
    Ok(Json(json!({
        "run_id": run_id,
        "success": outcome.success,
        "message": outcome.message,
        "metrics_written": outcome.metrics_written,
        "error": outcome.error,
    })))
}

#[derive(Deserialize)]
struct RunsQuery {
    #[serde(default)]
    limit: Option<i64>,
}

async fn run_history(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> Result<Json<Value>, ApiError> {
    let pg = db(&state)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows = pg
        .query(
            "SELECT id, started_at, finished_at, success, message, metrics_written, trigger
             FROM module_runs WHERE module_id = $1 ORDER BY started_at DESC LIMIT $2",
            &[&id, &limit],
        )
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let runs: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<_, i64>(0),
                "started_at": row.get::<_, chrono::DateTime<chrono::Utc>>(1),
                "finished_at": row.get::<_, Option<chrono::DateTime<chrono::Utc>>>(2),
                "success": row.get::<_, Option<bool>>(3),
                "message": row.get::<_, String>(4),
                "metrics_written": row.get::<_, i32>(5),
                "trigger": row.get::<_, String>(6),
            })
        })
        .collect();
    Ok(Json(json!({ "runs": runs })))
}

// ── Version switching ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SwitchVersionBody {
    version: String,
    wasm_url: String,
}

async fn switch_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<SwitchVersionBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let pg = db(&state)?;

    // Verify module is installed
    let row = pg
        .query_opt("SELECT manifest, registry_url FROM modules WHERE id = $1", &[&id])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("module {id:?} not installed")))?;

    let existing_manifest: Value = row.get(0);
    let registry_url: Option<String> = row.get(1);

    // Re-fetch the module.toml from the repo to get potential new widget_schema/config_schema
    let manifest_url = existing_manifest
        .get("manifest_url")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut manifest: Manifest = serde_json::from_value(existing_manifest.clone())
        .map_err(|e| ApiError::InternalError(format!("stored manifest invalid: {e}")))?;

    // If we have a registry entry, re-fetch the manifest to pick up schema changes
    if let Some(ref reg_url) = registry_url {
        if let Ok(index) = registry::fetch_index(reg_url).await {
            if let Some(entry) = index.modules.iter().find(|m| m.id == id) {
                if let Ok(fresh) = registry::fetch_manifest_only(entry).await {
                    manifest.config_schema = fresh.config_schema;
                    manifest.widget_schema = fresh.widget_schema;
                    manifest.permissions = fresh.permissions;
                }
            }
        }
    }

    // Update version
    manifest.version = body.version.clone();

    // Download the new WASM
    let client = reqwest::Client::builder()
        .user_agent("ZFS-Dashboard")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    let wasm_resp = client.get(&body.wasm_url).send().await
        .map_err(|e| ApiError::BadRequest(format!("failed to download wasm: {e}")))?;
    if !wasm_resp.status().is_success() {
        return Err(ApiError::BadRequest(format!("wasm download returned {}", wasm_resp.status())));
    }
    let wasm = wasm_resp.bytes().await
        .map_err(|e| ApiError::BadRequest(format!("failed to read wasm: {e}")))?;
    if wasm.len() > MAX_WASM_BYTES {
        return Err(ApiError::BadRequest(format!("wasm exceeds {} bytes", MAX_WASM_BYTES)));
    }

    // Validate the new component
    let runtime = state
        .module_runtime
        .as_ref()
        .ok_or(ApiError::InternalError("module runtime unavailable".into()))?;
    runtime
        .validate_component(&wasm)
        .map_err(ApiError::BadRequest)?;

    // Write WASM to disk
    let wasm_path = registry::wasm_path(&id)
        .ok_or(ApiError::BadRequest("invalid module id".into()))?;
    tokio::fs::write(&wasm_path, &wasm)
        .await
        .map_err(|e| ApiError::InternalError(format!("cannot store wasm: {e}")))?;

    let wasm_sha256 = registry::sha256_hex(&wasm);
    let manifest_json = serde_json::to_value(&manifest)
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    // Update DB — preserves config, secrets, run history
    pg.execute(
        "UPDATE modules SET version = $1, wasm_sha256 = $2, manifest = $3 WHERE id = $4",
        &[&manifest.version, &wasm_sha256, &manifest_json, &id],
    )
    .await
    .map_err(|e| ApiError::InternalError(e.to_string()))?;

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_version_switched", Some(&id),
          json!({ "version": body.version, "wasm_url": body.wasm_url })).await;
    Ok(Json(json!({ "ok": true, "version": body.version })))
}

// ── Metrics ingestion & query ───────────────────────────────────────────────

#[derive(Deserialize)]
struct MetricItem {
    metric_name: String,
    value: f64,
}

#[derive(Deserialize)]
struct PushMetricsBody {
    metrics: Vec<MetricItem>,
}

async fn push_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PushMetricsBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let pg = db(&state)?;

    let mut written = 0;
    for m in body.metrics {
        if !m.metric_name.is_empty() {
            pg.execute(
                "INSERT INTO module_metrics(module_id, metric_name, value, collected_at) VALUES($1, $2, $3, NOW())",
                &[&id, &m.metric_name, &m.value],
            )
            .await
            .map_err(|e| ApiError::InternalError(e.to_string()))?;
            written += 1;
        }
    }

    Ok(Json(json!({ "ok": true, "written": written })))
}

#[derive(Deserialize)]
struct ModuleMetricsQuery {
    metric: Option<String>,
    interval: Option<String>,
}

async fn get_module_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ModuleMetricsQuery>,
) -> Result<Json<Value>, ApiError> {
    let pg = db(&state)?;
    let interval = q.interval.as_deref().unwrap_or("1h");

    let time_clause = match interval {
        "6h" => "collected_at > NOW() - INTERVAL '6 hours'",
        "1d" => "collected_at > NOW() - INTERVAL '24 hours'",
        "1w" => "collected_at > NOW() - INTERVAL '7 days'",
        "1m" => "collected_at > NOW() - INTERVAL '30 days'",
        _ => "collected_at > NOW() - INTERVAL '1 hour'",
    };

    let rows = if let Some(ref metric_name) = q.metric {
        let query_str = format!(
            "SELECT metric_name, value, collected_at FROM module_metrics \
             WHERE module_id = $1 AND metric_name = $2 AND {} \
             ORDER BY collected_at ASC LIMIT 1000",
            time_clause
        );
        pg.query(&query_str, &[&id, metric_name])
            .await
            .map_err(|e| ApiError::InternalError(e.to_string()))?
    } else {
        let query_str = format!(
            "SELECT metric_name, value, collected_at FROM module_metrics \
             WHERE module_id = $1 AND {} \
             ORDER BY collected_at ASC LIMIT 1000",
            time_clause
        );
        pg.query(&query_str, &[&id])
            .await
            .map_err(|e| ApiError::InternalError(e.to_string()))?
    };

    let points: Vec<Value> = rows
        .iter()
        .map(|r| {
            let metric_name: String = r.get(0);
            let value: f64 = r.get(1);
            let collected_at: chrono::DateTime<chrono::Utc> = r.get(2);
            json!({
                "metric_name": metric_name,
                "value": value,
                "collected_at": collected_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({ "module_id": id, "metrics": points })))
}

// ── Dynamic module actions ──────────────────────────────────────────────────

async fn trigger_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, action_key)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_action_triggered", Some(&id), json!({ "action": action_key })).await;

    let trigger_name = format!("action:{action_key}");
    let (run_id, outcome) = execute_module(&state, &id, &trigger_name)
        .await
        .map_err(ApiError::BadRequest)?;

    Ok(Json(json!({
        "run_id": run_id,
        "action": action_key,
        "success": outcome.success,
        "message": outcome.message,
        "metrics_written": outcome.metrics_written,
        "error": outcome.error,
    })))
}

// ── Per-module database selection (internal PostgreSQL vs. external server) ──

fn module_db_key(id: &str) -> String {
    format!("module_db:{id}")
}

async fn read_module_db_raw(pg: &tokio_postgres::Client, id: &str) -> Value {
    pg.query_opt("SELECT value FROM app_settings WHERE key = $1", &[&module_db_key(id)])
        .await
        .ok()
        .flatten()
        .map(|row| row.get::<_, Value>(0))
        .unwrap_or_else(|| json!({}))
}

async fn write_module_db_raw(pg: &tokio_postgres::Client, id: &str, value: &Value) -> Result<(), ApiError> {
    pg.execute(
        "INSERT INTO app_settings(key, value, updated_at) VALUES($1, $2, NOW()) \
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
        &[&module_db_key(id), value],
    )
    .await
    .map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;
    Ok(())
}

fn public_module_db(stored: &Value) -> Value {
    let mode = stored.get("mode").and_then(|v| v.as_str()).unwrap_or("internal");
    let ext = stored.get("external").cloned().unwrap_or_else(|| json!({}));
    let has_password = ext
        .get("password_enc")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    json!({
        "mode": mode,
        "external": {
            "host": ext.get("host").and_then(|v| v.as_str()).unwrap_or(""),
            "port": ext.get("port").and_then(|v| v.as_i64()).unwrap_or(5432),
            "username": ext.get("username").and_then(|v| v.as_str()).unwrap_or(""),
            "database": ext.get("database").and_then(|v| v.as_str()).unwrap_or(""),
            "has_password": has_password,
        }
    })
}

async fn ensure_module_exists(pg: &tokio_postgres::Client, id: &str) -> Result<(), ApiError> {
    let exists = pg
        .query_opt("SELECT 1 FROM modules WHERE id = $1", &[&id])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    if exists.is_none() {
        return Err(ApiError::NotFound(format!("module {id:?} not installed")));
    }
    Ok(())
}

async fn get_module_database(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let pg = db(&state)?;
    ensure_module_exists(pg, &id).await?;
    let stored = read_module_db_raw(pg, &id).await;
    Ok(Json(public_module_db(&stored)))
}

#[derive(Deserialize)]
struct ModuleDbExternalBody {
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    database: Option<String>,
    /// None = keep stored password, Some("") = clear it, Some(pw) = replace it
    password: Option<String>,
}

#[derive(Deserialize)]
struct ModuleDbBody {
    mode: String,
    external: Option<ModuleDbExternalBody>,
}

async fn update_module_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ModuleDbBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    if body.mode != "internal" && body.mode != "external" {
        return Err(ApiError::BadRequest("'mode' must be 'internal' or 'external'".into()));
    }

    let pg = db(&state)?;
    ensure_module_exists(pg, &id).await?;

    let mut stored = read_module_db_raw(pg, &id).await;
    if stored.get("external").is_none() {
        stored["external"] = json!({});
    }

    if body.mode == "external" {
        let ext = body.external.as_ref()
            .ok_or_else(|| ApiError::BadRequest("'external' configuration is required".into()))?;
        let host = ext.host.as_deref().unwrap_or("").trim().to_string();
        let username = ext.username.as_deref().unwrap_or("").trim().to_string();
        let database = ext.database.as_deref().unwrap_or("").trim().to_string();
        if host.is_empty() || username.is_empty() || database.is_empty() {
            return Err(ApiError::BadRequest("'host', 'username' and 'database' are required for an external database".into()));
        }
        let port = ext.port.unwrap_or(5432);

        let password_enc = match &ext.password {
            None => stored
                .pointer("/external/password_enc")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            Some(p) if p.is_empty() => None,
            Some(p) => {
                let key = state.master_key
                    .ok_or_else(|| ApiError::InternalError("secrets master key unavailable".into()))?;
                let mut map = HashMap::new();
                map.insert("password".to_string(), p.clone());
                let blob = secrets::encrypt_secrets(&key, &map).map_err(ApiError::InternalError)?;
                Some(base64::engine::general_purpose::STANDARD.encode(blob))
            }
        };

        stored["mode"] = json!("external");
        stored["external"] = json!({
            "host": host,
            "port": port,
            "username": username,
            "database": database,
            "password_enc": password_enc,
        });
    } else {
        // Switching back to internal keeps the external config stored for later.
        stored["mode"] = json!("internal");
    }

    write_module_db_raw(pg, &id, &stored).await?;

    let actor = actor_from_headers(&state, &headers).await;
    audit(&state, &actor, "module_database_updated", Some(&id), json!({ "mode": body.mode })).await;
    Ok(Json(public_module_db(&stored)))
}

#[derive(Deserialize)]
struct ModuleDbTestBody {
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    database: Option<String>,
    /// Explicit password wins; when None, the stored password is used.
    password: Option<String>,
}

async fn test_module_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ModuleDbTestBody>,
) -> Result<Json<Value>, ApiError> {
    mgmt_rate_limit(&state, &headers)?;
    let pg = db(&state)?;
    ensure_module_exists(pg, &id).await?;

    let stored = read_module_db_raw(pg, &id).await;
    let stored_ext = stored.get("external").cloned().unwrap_or_else(|| json!({}));
    let stored_str = |k: &str| stored_ext.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());

    let host = body.host.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| stored_str("host"))
        .ok_or_else(|| ApiError::BadRequest("'host' is required".into()))?;
    let username = body.username.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| stored_str("username"))
        .ok_or_else(|| ApiError::BadRequest("'username' is required".into()))?;
    let database = body.database.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| stored_str("database"))
        .ok_or_else(|| ApiError::BadRequest("'database' is required".into()))?;
    let port = body.port
        .or_else(|| stored_ext.get("port").and_then(|v| v.as_i64()).map(|p| p as u16))
        .unwrap_or(5432);

    let password = match body.password {
        Some(p) if !p.is_empty() => Some(p),
        _ => match stored_str("password_enc") {
            Some(enc) => {
                let key = state.master_key
                    .ok_or_else(|| ApiError::InternalError("secrets master key unavailable".into()))?;
                let blob = base64::engine::general_purpose::STANDARD
                    .decode(enc)
                    .map_err(|e| ApiError::InternalError(format!("stored password is corrupt: {e}")))?;
                let map = secrets::decrypt_secrets(&key, &blob).map_err(ApiError::InternalError)?;
                map.get("password").cloned()
            }
            None => None,
        },
    };

    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&host).port(port).user(&username).dbname(&database);
    if let Some(ref pw) = password {
        cfg.password(pw);
    }

    let connect = cfg.connect(tokio_postgres::NoTls);
    match tokio::time::timeout(std::time::Duration::from_secs(5), connect).await {
        Ok(Ok((client, connection))) => {
            tokio::spawn(async move { let _ = connection.await; });
            match client.simple_query("SELECT 1").await {
                Ok(_) => Ok(Json(json!({ "ok": true, "message": "Verbindung erfolgreich" }))),
                Err(e) => Ok(Json(json!({ "ok": false, "message": format!("Query failed: {e}") }))),
            }
        }
        Ok(Err(e)) => Ok(Json(json!({ "ok": false, "message": format!("Connection failed: {e}") }))),
        Err(_) => Ok(Json(json!({ "ok": false, "message": "Connection timed out after 5s" }))),
    }
}
