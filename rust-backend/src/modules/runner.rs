use std::collections::HashMap;

use serde_json::Value;
use tracing::{info, warn};

use super::manifest::Manifest;
use super::net::hosts_from_config_urls;
use super::runtime::{ModuleCtx, RunLimits, RunOutcome};
use super::{registry, secrets};
use crate::state::AppState;

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

    let secret_values: HashMap<String, String> = match secrets_blob {
        Some(blob) => secrets::decrypt_secrets(&master_key.ok_or("secrets master key unavailable")?, &blob)?,
        None => HashMap::new(),
    };

    // Effective allowlist: manifest entries + hosts of url-typed config values.
    let mut allowlist = manifest.permissions.network_allowlist.clone();
    allowlist.extend(hosts_from_config_urls(&config, &manifest.url_keys()));

    let wasm_path = registry::wasm_path(module_id).ok_or("invalid module id")?;
    let wasm = tokio::fs::read(&wasm_path)
        .await
        .map_err(|e| format!("wasm artifact missing: {e}"))?;

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
