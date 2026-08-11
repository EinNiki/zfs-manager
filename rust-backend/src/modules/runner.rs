use std::collections::HashMap;

use serde_json::Value;
use tracing::{info, warn, debug};

use super::manifest::Manifest;
use super::net::hosts_from_config_urls;
use super::runtime::{ModuleCtx, RunLimits, RunOutcome};
use super::{registry, secrets};
use crate::state::AppState;

/// Fallback: load WASM from disk when not in DB (backward compat for
/// modules installed before wasm_bytes column was added).
fn load_wasm_from_disk(module_id: &str) -> Result<Vec<u8>, String> {
    let wasm_path = registry::wasm_path(module_id).ok_or("invalid module id")?;
    let modules_dir = registry::modules_dir();
    std::fs::read(&wasm_path).map_err(|e| {
        let files: Vec<String> = std::fs::read_dir(&modules_dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        warn!(
            "module {module_id}: wasm not in DB and not on disk at {wasm_path}: {e}\n\
             modules_dir={modules_dir}\n\
             existing files={files:?}"
        );
        format!(
            "wasm artifact missing: {e} (path: {wasm_path}, modules_dir: {modules_dir}, existing files: {files:?}). \
             Re-install the module to persist its WASM in the database."
        )
    })
}

/// Executes one run of an installed module and records it in `module_runs`.
/// Returns the run id together with the outcome.
pub async fn execute_module(state: &AppState, module_id: &str, trigger: &str) -> Result<(i64, RunOutcome), String> {
    let pg = state.pg.as_ref().ok_or("database unavailable")?;
    let runtime = state.module_runtime.as_ref().ok_or("module runtime unavailable")?;
    let master_key = state.master_key;

    let row = pg
        .query_opt(
            "SELECT m.manifest, m.enabled, c.config, c.secrets
             FROM modules m LEFT JOIN module_configs c ON c.module_id = m.id
             WHERE m.id = $1",
            &[&module_id],
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("module {module_id:?} is not installed"))?;

    let manifest_json: Value = row.get(0);
    let manifest: Manifest =
        serde_json::from_value(manifest_json).map_err(|e| format!("stored manifest invalid: {e}"))?;
    let mut config: Value = row.get::<_, Option<Value>>(2).unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = config.as_object_mut() {
        for field in &manifest.config_schema {
            if field.field_type != "secret" && !obj.contains_key(&field.key) {
                if let Some(ref def) = field.default {
                    obj.insert(field.key.clone(), def.clone());
                } else if field.field_type == "multiselect" {
                    obj.insert(field.key.clone(), serde_json::json!([]));
                } else if field.field_type == "number" {
                    obj.insert(field.key.clone(), serde_json::json!(0));
                } else {
                    obj.insert(field.key.clone(), serde_json::json!(""));
                }
            }
        }
    }
    let secrets_blob: Option<Vec<u8>> = row.get(3);

    // Check if the manifest has any secret fields. If not, we don't need
    // to decrypt the blob at all — and if decryption fails (e.g. master key
    // changed after restart), we can safely ignore stale secrets.
    let has_secret_fields = manifest.config_schema.iter().any(|f| f.field_type == "secret");

    let secret_values: HashMap<String, String> = match secrets_blob {
        Some(blob) if has_secret_fields => {
            secrets::decrypt_secrets(&master_key.ok_or("secrets master key unavailable")?, &blob)
                .unwrap_or_else(|e| {
                    warn!("module {module_id}: failed to decrypt secrets blob ({e}) — module has secret fields, using empty secrets");
                    HashMap::new()
                })
        }
        Some(_) => {
            // Module has no secret fields but a stale blob exists — ignore it.
            // Could clear it from DB here, but that's a write on every run;
            // the next config save will overwrite it with an empty blob anyway.
            HashMap::new()
        }
        None => HashMap::new(),
    };

    // Effective allowlist: manifest entries + hosts of url-typed config values.
    let mut allowlist = manifest.permissions.network_allowlist.clone();
    allowlist.extend(hosts_from_config_urls(&config, &manifest.url_keys()));
    debug!("module {module_id}: allowlist = {:?}", allowlist);
    debug!("module {module_id}: config = {}", config);

    // Validate required config fields before running the module.
    // Checks both the public config and the decrypted secrets.
    let mut missing: Vec<String> = Vec::new();
    for field in &manifest.config_schema {
        if !field.required { continue; }
        let is_secret = field.field_type == "secret";
        let value = if is_secret {
            // Secrets are not in the config JSON — check the decrypted map
            secret_values.get(&field.key).map(|s| s.trim().to_string()).unwrap_or_default()
        } else {
            config.get(&field.key)
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        };
        if value.is_empty() {
            missing.push(field.label.clone());
        }
    }
    if !missing.is_empty() {
        let msg = format!(
            "Required configuration fields are empty: {}. \
             Please fill them in the module settings before running.",
            missing.join(", ")
        );
        warn!("module {module_id}: run blocked — missing required fields: {:?}", missing);
        // Record a failed run in the DB so the user sees it in the history
        let run_id: i64 = pg
            .query_one(
                "INSERT INTO module_runs(module_id, trigger) VALUES($1, $2) RETURNING id",
                &[&module_id, &trigger],
            )
            .await
            .map_err(|e| e.to_string())?
            .get(0);
        // Mark the run as finished with the error
        if let Err(e) = pg
            .execute(
                "UPDATE module_runs SET finished_at = NOW(), success = FALSE, message = $1, metrics_written = 0 WHERE id = $2",
                &[&msg, &run_id],
            )
            .await
        {
            warn!("module {module_id}: failed to record blocked run {run_id}: {e}");
        }
        let outcome = RunOutcome {
            success: false,
            message: String::new(),
            metrics_written: 0,
            error: Some(msg.clone()),
            logs: vec![format!("[warn] {msg}")],
        };
        return Ok((run_id, outcome));
    }

    // Load WASM bytes. Primary source: PostgreSQL (survives container restarts).
    // Fallback: disk file at /app/modules/<id>.wasm (for backward compat).
    let wasm: Vec<u8> = {
        let row = pg
            .query_opt("SELECT wasm_bytes FROM modules WHERE id = $1", &[&module_id])
            .await
            .map_err(|e| format!("db error: {e}"))?;
        if let Some(row) = row {
            let wasm_bytes: Option<Vec<u8>> = row.get(0);
            if let Some(bytes) = wasm_bytes {
                if !bytes.is_empty() {
                    debug!("module {module_id}: loaded {} bytes from DB", bytes.len());
                    bytes
                } else {
                    // DB has NULL/empty wasm_bytes — try disk fallback
                    load_wasm_from_disk(module_id)?
                }
            } else {
                load_wasm_from_disk(module_id)?
            }
        } else {
            return Err(format!("module {module_id:?} not found in DB"));
        }
    };
    debug!("module {module_id}: wasm loaded, {} bytes", wasm.len());

    let run_id: i64 = pg
        .query_one(
            "INSERT INTO module_runs(module_id, trigger) VALUES($1, $2) RETURNING id",
            &[&module_id, &trigger],
        )
        .await
        .map_err(|e| e.to_string())?
        .get(0);

    info!("module {module_id}: run {run_id} started ({trigger})");
    let ctx = ModuleCtx {
        module_id: module_id.to_string(),
        allowlist,
        secrets: secret_values,
        pg: Some(pg.clone()),
        config_json: config.to_string(),
        internal_token: state.internal_module_token.as_ref().clone(),
    };
    let outcome = runtime.run(&wasm, ctx, &RunLimits::default()).await;

    let mut message = outcome.message.clone();
    if !outcome.logs.is_empty() {
        if !message.is_empty() {
            message.push('\n');
        }
        message.push_str(&outcome.logs.join("\n"));
    }
    // Char-safe: message contains guest-controlled log text. A non-boundary
    // String::truncate would panic (see runtime::truncate_on_char_boundary).
    if message.len() > 64 * 1024 {
        let mut end = 64 * 1024;
        while end > 0 && !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    let full_message = match &outcome.error {
        Some(err) if message.is_empty() => err.clone(),
        Some(err) => format!("{err}\n{message}"),
        None => message,
    };

    if let Err(e) = pg
        .execute(
            "UPDATE module_runs SET finished_at = NOW(), success = $1, message = $2, metrics_written = $3 WHERE id = $4",
            &[&outcome.success, &full_message, &(outcome.metrics_written as i32), &run_id],
        )
        .await
    {
        warn!("module {module_id}: failed to record run {run_id}: {e}");
    }
    info!(
        "module {module_id}: run {run_id} finished (success={}, metrics={})",
        outcome.success, outcome.metrics_written
    );
    Ok((run_id, outcome))
}

/// Parses a schedule value: plain seconds ("300"), "Ns/Nm/Nh" shorthand, or a
/// 6/7-field cron expression. Returns the interval representation.
pub enum Schedule {
    IntervalSecs(u64),
    Cron(Box<cron::Schedule>),
}

pub fn parse_schedule(raw: &str) -> Result<Schedule, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("empty schedule".into());
    }
    if let Ok(secs) = text.parse::<u64>() {
        return validated_interval(secs);
    }
    if let Some(rest) = text.strip_suffix(['s', 'm', 'h']) {
        if let Ok(n) = rest.parse::<u64>() {
            let secs = match text.chars().last().unwrap() {
                's' => n,
                'm' => n * 60,
                _ => n * 3600,
            };
            return validated_interval(secs);
        }
    }
    use std::str::FromStr;
    cron::Schedule::from_str(text)
        .map(|s| Schedule::Cron(Box::new(s)))
        .map_err(|e| format!("invalid schedule {text:?}: {e}"))
}

fn validated_interval(secs: u64) -> Result<Schedule, String> {
    if secs < 30 {
        return Err("interval must be at least 30 seconds".into());
    }
    Ok(Schedule::IntervalSecs(secs))
}

/// Whether a module is due, given its schedule and the last run start.
pub fn is_due(schedule: &Schedule, last_run: Option<chrono::DateTime<chrono::Utc>>, now: chrono::DateTime<chrono::Utc>) -> bool {
    match (schedule, last_run) {
        (_, None) => true,
        (Schedule::IntervalSecs(secs), Some(last)) => {
            now.signed_duration_since(last).num_seconds() >= *secs as i64
        }
        (Schedule::Cron(cron), Some(last)) => cron
            .after(&last)
            .next()
            .map(|next| next <= now)
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};

    #[test]
    fn parses_interval_forms() {
        assert!(matches!(parse_schedule("300"), Ok(Schedule::IntervalSecs(300))));
        assert!(matches!(parse_schedule("5m"), Ok(Schedule::IntervalSecs(300))));
        assert!(matches!(parse_schedule("2h"), Ok(Schedule::IntervalSecs(7200))));
        assert!(parse_schedule("10").is_err()); // below minimum
        assert!(parse_schedule("nonsense").is_err());
    }

    #[test]
    fn parses_cron() {
        assert!(matches!(parse_schedule("0 0 * * * *"), Ok(Schedule::Cron(_))));
    }

    #[test]
    fn due_logic() {
        let now = Utc::now();
        let s = Schedule::IntervalSecs(300);
        assert!(is_due(&s, None, now));
        assert!(is_due(&s, Some(now - Duration::seconds(301)), now));
        assert!(!is_due(&s, Some(now - Duration::seconds(60)), now));

        let hourly = parse_schedule("0 0 * * * *").unwrap();
        assert!(is_due(&hourly, Some(now - Duration::hours(2)), now));
        assert!(!is_due(&hourly, Some(now), now.min(now)));
    }
}
