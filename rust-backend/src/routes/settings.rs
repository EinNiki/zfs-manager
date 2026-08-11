use axum::{
    extract::{Path, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Sha256, Digest};
use rand::Rng;
use std::sync::LazyLock;
use tokio::sync::RwLock;

use crate::state::AppState;
use crate::error::ApiError;

/// In-memory cache for the accent color so GET doesn't hit PostgreSQL on
/// every page load. Loaded once at startup, updated on PUT.
static ACCENT_COLOR_CACHE: LazyLock<RwLock<Option<String>>> =
    LazyLock::new(|| RwLock::new(None));

/// Load the accent color from DB into memory at startup.
pub async fn init_accent_color_cache(pg: &tokio_postgres::Client) {
    if let Ok(row) = pg
        .query_opt("SELECT value FROM app_settings WHERE key = 'accent_color'", &[])
        .await
    {
        if let Some(r) = row {
            if let Some(color) = r.get::<_, Value>(0).as_str() {
                *ACCENT_COLOR_CACHE.write().await = Some(color.to_string());
                return;
            }
        }
    }
    *ACCENT_COLOR_CACHE.write().await = Some("#6366f1".to_string());
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/settings/api-keys",     get(list_api_keys).post(create_api_key))
        .route("/api/v1/settings/api-keys/:id", delete(revoke_api_key))
        .route("/api/v1/settings/password",     post(change_password))
        .route("/api/v1/settings/github-interval", get(get_github_interval).put(set_github_interval))
        .route("/api/v1/settings/github-token", get(get_github_token).put(set_github_token))
        .route("/api/v1/settings/accent-color", get(get_accent_color).put(set_accent_color))
        .with_state(state)
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn generate_key() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

async fn list_api_keys(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;

    let rows = pg.query(
        "SELECT id, name, key_prefix, permissions, created_at, last_used_at FROM api_keys ORDER BY created_at DESC",
        &[],
    ).await.map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;

    let keys: Vec<Value> = rows.iter().map(|row| {
        let id: i32 = row.get(0);
        let name: String = row.get(1);
        let prefix: String = row.get(2);
        let permissions: String = row.get(3);
        let created_at: chrono::DateTime<chrono::Utc> = row.get(4);
        let last_used_at: Option<chrono::DateTime<chrono::Utc>> = row.get(5);
        json!({
            "id": id,
            "name": name,
            "key_prefix": prefix,
            "permissions": permissions,
            "created_at": created_at.to_rfc3339(),
            "last_used_at": last_used_at.map(|t| t.to_rfc3339()),
        })
    }).collect();

    Ok(Json(json!({ "keys": keys })))
}

#[derive(Deserialize)]
struct CreateApiKeyBody {
    name: String,
    permissions: String,
}

async fn create_api_key(
    State(state): State<AppState>,
    Json(body): Json<CreateApiKeyBody>,
) -> Result<Json<Value>, ApiError> {
    if body.name.is_empty() {
        return Err(ApiError::BadRequest("'name' is required".into()));
    }
    if body.name.len() > 64 {
        return Err(ApiError::BadRequest("'name' must be at most 64 characters".into()));
    }
    let valid_perms = ["read", "readwrite", "admin"];
    if !valid_perms.contains(&body.permissions.as_str()) {
        return Err(ApiError::BadRequest("'permissions' must be one of: read, readwrite, admin".into()));
    }

    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;

    let key = generate_key();
    let prefix = key[..8].to_string();
    let key_hash = hash_token(&key);

    let row = pg.query_one(
        "INSERT INTO api_keys(name, key_hash, key_prefix, permissions) VALUES($1,$2,$3,$4) RETURNING id",
        &[&body.name, &key_hash, &prefix, &body.permissions],
    ).await.map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;

    let id: i32 = row.get(0);

    Ok(Json(json!({
        "key": key,
        "prefix": prefix,
        "id": id,
    })))
}

async fn revoke_api_key(
    State(state): State<AppState>,
    Path(id): Path<i32>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;

    pg.execute("DELETE FROM api_keys WHERE id = $1", &[&id])
        .await
        .map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ChangePasswordBody {
    current_password: String,
    new_password: String,
    confirm_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    Json(body): Json<ChangePasswordBody>,
) -> Result<Json<Value>, ApiError> {
    if body.new_password.len() < 12 {
        return Err(ApiError::BadRequest("New password must be at least 12 characters".into()));
    }
    if body.new_password != body.confirm_password {
        return Err(ApiError::BadRequest("New password and confirmation do not match".into()));
    }

    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;

    // Verify current password
    let mut verified = false;
    let result = pg.query_opt(
        "SELECT password_hash FROM users WHERE username = 'admin'",
        &[],
    ).await.map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;

    if let Some(row) = result {
        let stored_hash: String = row.get(0);
        let pw = body.current_password.clone();
        verified = tokio::task::spawn_blocking(move || {
            bcrypt::verify(&pw, &stored_hash).unwrap_or(false)
        }).await.unwrap_or(false);
    }

    if !verified {
        return Err(ApiError::BadRequest("Current password is incorrect".into()));
    }

    // Hash new password
    let new_pw = body.new_password.clone();
    let new_hash = tokio::task::spawn_blocking(move || {
        bcrypt::hash(new_pw, 12)
    }).await
        .map_err(|e| ApiError::InternalError(format!("Spawn error: {e}")))?
        .map_err(|e| ApiError::InternalError(format!("Bcrypt error: {e}")))?;

    pg.execute(
        "UPDATE users SET password_hash = $1, is_default_password = false WHERE username = 'admin'",
        &[&new_hash],
    ).await.map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;

    // Invalidate all sessions so every active browser session must re-login
    pg.execute("DELETE FROM sessions", &[])
        .await
        .map_err(|e| ApiError::InternalError(format!("DB error: {e}")))?;

    // Purge session cache from Redis so cached sessions can't bypass the DB check
    if let Some(ref redis_conn) = state.redis {
        use redis::AsyncCommands;
        let mut conn = redis_conn.clone();
        let mut cursor = 0u64;
        loop {
            let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg("zfs:session:*")
                .arg("COUNT")
                .arg(100u64)
                .query_async(&mut conn)
                .await
                .unwrap_or((0, vec![]));
            if !keys.is_empty() {
                let _: redis::RedisResult<()> = conn.del(keys).await;
            }
            cursor = next_cursor;
            if cursor == 0 { break; }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

// ── GitHub update interval ──────────────────────────────────────────────────

/// GET /api/v1/settings/github-interval
/// Returns the configured GitHub API refresh interval in hours.
async fn get_github_interval(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;
    let row = pg
        .query_opt("SELECT value FROM app_settings WHERE key = 'github_update_interval_hours'", &[])
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    let hours: u64 = row
        .and_then(|r| r.get::<_, Value>(0).as_u64())
        .unwrap_or(6) // default
        .clamp(1, 168);

    Ok(Json(json!({ "hours": hours })))
}

#[derive(Deserialize)]
struct SetGithubIntervalBody {
    hours: u64,
}

/// PUT /api/v1/settings/github-interval
/// Sets the GitHub API refresh interval (1-168 hours).
async fn set_github_interval(
    State(state): State<AppState>,
    Json(body): Json<SetGithubIntervalBody>,
) -> Result<Json<Value>, ApiError> {
    let hours = body.hours.clamp(1, 168);
    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;
    pg.execute(
        "INSERT INTO app_settings(key, value, updated_at) VALUES('github_update_interval_hours', $1, NOW()) \
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
        &[&serde_json::json!(hours)],
    )
    .await
    .map_err(|e| ApiError::InternalError(e.to_string()))?;

    Ok(Json(json!({ "hours": hours })))
}

// ── GitHub token ─────────────────────────────────────────────────────────────

/// GET /api/v1/settings/github-token
/// Returns only whether a GitHub token is configured (never the token itself
/// or any part of it — no masked prefix to avoid leaking token fragments).
async fn get_github_token(
    State(_state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let token = crate::modules::github_token::get().await;
    Ok(Json(json!({ "configured": token.is_some() })))
}

#[derive(Deserialize)]
struct SetGithubTokenBody {
    token: String,
}

/// PUT /api/v1/settings/github-token
/// Sets or clears the GitHub token. Pass empty string to clear.
async fn set_github_token(
    State(state): State<AppState>,
    Json(body): Json<SetGithubTokenBody>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;
    crate::modules::github_token::set(&body.token, Some(pg))
        .await
        .map_err(ApiError::InternalError)?;

    let configured = !body.token.trim().is_empty();
    Ok(Json(json!({ "configured": configured })))
}

// ── Accent color ─────────────────────────────────────────────────────────────

/// GET /api/v1/settings/accent-color
/// Reads from in-memory cache — no PostgreSQL hit. Public (no auth).
async fn get_accent_color(
    State(_state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let color = ACCENT_COLOR_CACHE.read().await
        .clone()
        .unwrap_or_else(|| "#6366f1".to_string());
    Ok(Json(json!({ "color": color })))
}

#[derive(Deserialize)]
struct SetAccentColorBody {
    color: String,
}

/// PUT /api/v1/settings/accent-color
/// Updates DB and in-memory cache.
async fn set_accent_color(
    State(state): State<AppState>,
    Json(body): Json<SetAccentColorBody>,
) -> Result<Json<Value>, ApiError> {
    // Validate hex color format
    let color = body.color.trim().to_string();
    if !color.starts_with('#') || color.len() != 7 || !color[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest("color must be a valid hex color like #6366f1".into()));
    }
    let pg = state.pg.as_ref().ok_or_else(|| ApiError::InternalError("Database unavailable".into()))?;
    pg.execute(
        "INSERT INTO app_settings(key, value, updated_at) VALUES('accent_color', $1, NOW()) \
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
        &[&serde_json::json!(color)],
    )
    .await
    .map_err(|e| ApiError::InternalError(e.to_string()))?;

    // Update in-memory cache
    *ACCENT_COLOR_CACHE.write().await = Some(color.clone());

    Ok(Json(json!({ "color": color })))
}
