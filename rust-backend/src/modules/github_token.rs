//! Shared GitHub token for API authentication and private repo access.
//!
//! The token is loaded at startup from the `GITHUB_TOKEN` env var or the
//! `github_token` key in `app_settings`. It can be updated at runtime via
//! the settings API. All GitHub HTTP calls (API + raw.githubusercontent.com
//! + release asset downloads) use this token for auth, enabling:
//! - 5000 req/hour instead of 60 (rate limit)
//! - Access to private repositories

use std::sync::LazyLock;
use tokio::sync::RwLock;

static GITHUB_TOKEN: LazyLock<RwLock<Option<String>>> =
    LazyLock::new(|| RwLock::new(None));

/// Initialize the token from env var or DB. Called once at startup.
pub async fn init(pg: Option<&tokio_postgres::Client>) {
    // Env var takes priority
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            *GITHUB_TOKEN.write().await = Some(token);
            tracing::info!("github_token: loaded from GITHUB_TOKEN env var");
            return;
        }
    }

    // Fall back to DB
    if let Some(pg) = pg {
        if let Ok(row) = pg
            .query_opt("SELECT value FROM app_settings WHERE key = 'github_token'", &[])
            .await
        {
            if let Some(r) = row {
                if let Some(token) = r.get::<_, serde_json::Value>(0).as_str() {
                    let token = token.trim().to_string();
                    if !token.is_empty() {
                        *GITHUB_TOKEN.write().await = Some(token);
                        tracing::info!("github_token: loaded from app_settings");
                        return;
                    }
                }
            }
        }
    }

    tracing::info!("github_token: not configured (unauthenticated GitHub API, 60 req/hour limit)");
}

/// Returns the current GitHub token, or `None` if not set.
pub async fn get() -> Option<String> {
    GITHUB_TOKEN.read().await.clone()
}

/// Updates the token (called from settings API). Also persists to DB.
pub async fn set(token: &str, pg: Option<&tokio_postgres::Client>) -> Result<(), String> {
    let token = token.trim().to_string();
    *GITHUB_TOKEN.write().await = if token.is_empty() { None } else { Some(token.clone()) };

    if let Some(pg) = pg {
        pg.execute(
            "INSERT INTO app_settings(key, value, updated_at) VALUES('github_token', $1, NOW()) \
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
            &[&serde_json::json!(token)],
        )
        .await
        .map_err(|e| format!("DB error: {e}"))?;
    }

    Ok(())
}

/// Builds the Authorization header value if a token is set.
/// Returns `("Authorization", "Bearer <token>")` or `None`.
pub async fn auth_header() -> Option<(String, String)> {
    get().await.map(|t| ("Authorization".to_string(), format!("Bearer {t}")))
}
