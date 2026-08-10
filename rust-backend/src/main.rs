use axum::{
    extract::Request,
    middleware::{self, Next},
    response::Response,
    http::StatusCode,
    Router,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};
use axum::http::HeaderValue as AxumHeaderValue;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use std::sync::Mutex;

static UI_FIRST_CONTACT: AtomicBool = AtomicBool::new(false);

use zfs_dashboard::{modules, routes, startup, state, worker};

use state::AppState;

fn get_client_ip(req: &Request) -> String {
    if let Some(fwd) = req.headers().get("x-forwarded-for") {
        if let Ok(s) = fwd.to_str() {
            return s.split(',').next().unwrap_or("unknown").trim().to_string();
        }
    }
    if let Some(real) = req.headers().get("x-real-ip") {
        if let Ok(s) = real.to_str() {
            return s.to_string();
        }
    }
    "unknown".to_string()
}

fn hash_token(token: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

async fn auth_middleware(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = req.uri().path().to_string();

    // Allow health and login without auth
    if path.ends_with("/health") || path.ends_with("/auth/login") {
        return Ok(next.run(req).await);
    }

    let token_opt = req.headers()
        .get("x-api-key")
        .or_else(|| req.headers().get("Authorization"))
        .and_then(|h| h.to_str().ok())
        .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string());

    if let Some(ref token) = token_opt {
        let token_hash = hash_token(token);

        // Check Redis session first (fast path)
        if let Some(ref redis_conn) = state.redis {
            use redis::AsyncCommands;
            let mut conn = redis_conn.clone();
            let session_key = format!("zfs:session:{}", token_hash);
            let cached = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                conn.get::<_, Option<String>>(&session_key)
            ).await;
            if let Ok(Ok(Some(_))) = cached {
                return Ok(next.run(req).await);
            }
        }

        // Check DB sessions table
        if let Some(ref pg) = state.pg {
            let result = pg.query_opt(
                "SELECT token_hash FROM sessions WHERE token_hash = $1 AND expires_at > NOW()",
                &[&token_hash],
            ).await;
            if let Ok(Some(_)) = result {
                // Refresh Redis cache
                if let Some(ref redis_conn) = state.redis {
                    use redis::AsyncCommands;
                    let mut conn = redis_conn.clone();
                    let session_key = format!("zfs:session:{}", token_hash);
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        conn.set_ex::<_, _, ()>(&session_key, "admin", 86400u64)
                    ).await;
                }
                return Ok(next.run(req).await);
            }
        }

        // Check API keys
        if let Some(ref pg) = state.pg {
            let result = pg.query_opt(
                "SELECT id FROM api_keys WHERE key_hash = $1",
                &[&token_hash],
            ).await;
            if let Ok(Some(row)) = result {
                let key_id: i32 = row.get(0);
                // Update last_used_at non-blocking
                let pg_clone = pg.clone();
                tokio::spawn(async move {
                    let _ = pg_clone.execute(
                        "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1",
                        &[&key_id],
                    ).await;
                });
                return Ok(next.run(req).await);
            }
        }

    }

    if !UI_FIRST_CONTACT.load(Ordering::Relaxed) {
        if let Some(agent) = req.headers().get("user-agent") {
            let agent_str = agent.to_str().unwrap_or("unknown");
            if agent_str.contains("Mozilla") || agent_str.contains("Chrome") || agent_str.contains("Safari") {
                info!("UI: First contact established from {}", req.uri());
                UI_FIRST_CONTACT.store(true, Ordering::Relaxed);
            }
        }
    }

    // Log failed attempt
    let ip = get_client_ip(&req);
    if let Some(ref pg) = state.pg {
        let pg_clone = pg.clone();
        let ip_clone = ip.clone();
        tokio::spawn(async move {
            let _ = pg_clone.execute(
                "INSERT INTO login_attempts(ip_address, success) VALUES($1, false)",
                &[&ip_clone],
            ).await;
        });
    }
    warn!("Unauthorized access attempt from {ip}");

    Err(StatusCode::UNAUTHORIZED)
}

async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    use axum::http::HeaderValue;
    h.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    h.insert("X-Frame-Options",        HeaderValue::from_static("DENY"));
    h.insert("X-XSS-Protection",       HeaderValue::from_static("1; mode=block"));
    h.insert("Content-Security-Policy", HeaderValue::from_static("default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; font-src * data:; style-src * 'unsafe-inline'; connect-src *;"));
    h.insert("Referrer-Policy",        HeaderValue::from_static("same-origin"));
    res
}

mod migrations {
    refinery::embed_migrations!("migrations");
}

async fn init_schema(client: &mut tokio_postgres::Client) {
    match migrations::migrations::runner().run_async(client).await {
        Ok(report) => {
            let applied = report.applied_migrations().len();
            if applied > 0 {
                info!("PostgreSQL migrations applied: {applied}");
            } else {
                info!("PostgreSQL schema up to date");
            }
        }
        Err(e) => warn!("Failed to run PostgreSQL migrations: {e}"),
    }
    // Keep the planner statistics fresh on the largest table (was part of the
    // old inline schema init and ran on every startup).
    let _ = client.batch_execute("ANALYZE zfs_metrics;").await;
}

async fn seed_admin_user(client: &tokio_postgres::Client, api_key: &str) {
    let count: i64 = client.query_one("SELECT COUNT(*) FROM users", &[]).await
        .map(|r| r.get(0)).unwrap_or(0);
    if count == 0 {
        let hash = tokio::task::spawn_blocking({
            let key = api_key.to_string();
            move || bcrypt::hash(key, 12)
        }).await.ok().and_then(|r| r.ok());
        if let Some(h) = hash {
            let is_default = api_key == "admin123";
            let _ = client.execute(
                "INSERT INTO users(username, password_hash, is_default_password) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                &[&"admin", &h, &is_default],
            ).await;
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Received termination signal, starting graceful shutdown...");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    startup::run_startup_checks().await;
    startup::run_startup_pool_imports().await;
    startup::run_startup_zfs_mount().await;

    let port: u16 = std::env::var("ZFS_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let redis_url = std::env::var("REDIS_URL")
        .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());

    let redis_conn = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => match redis::aio::ConnectionManager::new(client).await {
            Ok(mgr) => {
                info!("Redis connected at {redis_url}");
                Some(mgr)
            }
            Err(e) => {
                warn!("Redis connection manager failed: {e}");
                None
            }
        },
        Err(e) => {
            warn!("Redis client open failed: {e}");
            None
        }
    };

    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://zfs:zfs_secret@127.0.0.1:5432/zfs_metrics".to_string());

    let pg_client = match tokio_postgres::connect(&db_url, tokio_postgres::NoTls).await {
        Ok((mut client, connection)) => {
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    warn!("PostgreSQL connection error: {e}");
                }
            });
            info!("PostgreSQL connected");
            init_schema(&mut client).await;
            let admin_password = {
                let v = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
                if v.is_empty() {
                    warn!("ADMIN_PASSWORD not set — using insecure default 'admin123'. Change this immediately via the UI or set ADMIN_PASSWORD.");
                    "admin123".to_string()
                } else {
                    v
                }
            };
            seed_admin_user(&client, &admin_password).await;
            Some(Arc::new(client))
        }
        Err(e) => {
            warn!("PostgreSQL connection failed: {e}");
            None
        }
    };

    let rate_limit: state::RateLimitMap = Arc::new(Mutex::new(HashMap::new()));

    let mut init_read: u64 = 0;
    let mut init_write: u64 = 0;
    let db_backend = std::env::var("DB_BACKEND").unwrap_or_else(|_| "postgres".to_string());
    if db_backend == "redis" {
        if let Some(ref redis) = redis_conn {
            use redis::AsyncCommands;
            let mut conn = redis.clone();
            if let Ok(Some(v)) = conn.get::<_, Option<String>>("zfs:totals:read_bytes").await {
                init_read = v.parse().unwrap_or(0);
            }
            if let Ok(Some(v)) = conn.get::<_, Option<String>>("zfs:totals:write_bytes").await {
                init_write = v.parse().unwrap_or(0);
            }
            info!("Loaded totals from Redis: read={init_read} write={init_write}");
        }
    } else if let Some(ref pg) = pg_client {
        // Create the row if it doesn't exist
        let _ = pg.execute(
            "INSERT INTO global_stats(id, total_read_bytes, total_write_bytes) VALUES(1, 0, 0) ON CONFLICT DO NOTHING",
            &[],
        ).await;
        if let Ok(row) = pg.query_one("SELECT total_read_bytes, total_write_bytes FROM global_stats WHERE id = 1", &[]).await {
            init_read = row.get::<_, i64>(0) as u64;
            init_write = row.get::<_, i64>(1) as u64;
        }
        info!("Loaded totals from PostgreSQL: read={init_read} write={init_write}");

        // Bootstrap from existing zfs_metrics when global_stats hasn't been populated yet.
        // Each DB row holds a bytes/sec rate (read_bw_mb MB/s) for a 2-second measurement
        // window, so total bytes = SUM(read_bw_mb * 2.0 * 1_048_576).
        // This keeps the all-time counter consistent with what the chart calculates,
        // and prevents "all-time total < 24h chart value" on fresh installations.
        if init_read == 0 && init_write == 0 {
            if let Ok(row) = pg.query_one(
                "SELECT COALESCE(SUM(read_bw_mb),0)::float8, COALESCE(SUM(write_bw_mb),0)::float8 FROM zfs_metrics",
                &[],
            ).await {
                let sum_r: f64 = row.get(0);
                let sum_w: f64 = row.get(1);
                if sum_r > 0.0 || sum_w > 0.0 {
                    // Multiply by 2.0 (tick seconds) to convert MB/s sum → MB total, then to bytes
                    init_read  = (sum_r * 2.0 * 1_048_576.0) as u64;
                    init_write = (sum_w * 2.0 * 1_048_576.0) as u64;
                    info!("Bootstrapped totals from zfs_metrics history: read={init_read} write={init_write}");
                    let tr_i = init_read  as i64;
                    let tw_i = init_write as i64;
                    let _ = pg.execute(
                        "UPDATE global_stats SET total_read_bytes=$1, total_write_bytes=$2 WHERE id=1",
                        &[&tr_i, &tw_i],
                    ).await;
                }
            }
        }
    }

    // Load persisted per-disk totals so they survive restarts.
    let init_disk_cumulative: HashMap<String, HashMap<String, (u64, u64)>> =
        if let Some(ref pg) = pg_client {
            match pg.query(
                "SELECT pool_name, disk_name, total_read_bytes, total_write_bytes FROM disk_stats",
                &[],
            ).await {
                Ok(rows) => {
                    let mut map: HashMap<String, HashMap<String, (u64, u64)>> = HashMap::new();
                    for row in rows {
                        let pool: String = row.get(0);
                        let disk: String = row.get(1);
                        let r: i64       = row.get(2);
                        let w: i64       = row.get(3);
                        map.entry(pool).or_default().insert(disk, (r as u64, w as u64));
                    }
                    info!("Loaded disk totals from PostgreSQL ({} entries)", map.values().map(|m| m.len()).sum::<usize>());
                    map
                }
                Err(e) => {
                    warn!("Failed to load disk_stats: {e}");
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };

    let module_runtime = match modules::runtime::ModuleRuntime::new() {
        Ok(rt) => Some(Arc::new(rt)),
        Err(e) => {
            warn!("Module runtime unavailable: {e}");
            None
        }
    };
    let master_key = match modules::secrets::load_master_key() {
        Ok(key) => {
            modules::secrets::verify_master_key(&key);
            Some(key)
        }
        Err(e) => {
            warn!("Secrets master key unavailable: {e} — module secrets disabled");
            None
        }
    };
    if let Some(ref pg) = pg_client {
        // Default registry is non-persisted and dynamically served from code/ENV.
        // Clean up any legacy default registry entries from PostgreSQL.
        let _ = pg
            .execute("DELETE FROM module_registries WHERE is_default = TRUE", &[])
            .await;
    }

    let app_state = AppState {
        redis: redis_conn,
        pg: pg_client,
        rate_limit,
        module_runtime,
        master_key,
        total_read_bytes: Arc::new(AtomicU64::new(init_read)),
        total_write_bytes: Arc::new(AtomicU64::new(init_write)),
        io_cache: Arc::new(tokio::sync::RwLock::new(state::CachedIoSnapshot::default())),
        disk_cumulative: Arc::new(tokio::sync::RwLock::new(init_disk_cumulative)),
    };

    // Startup: warm Redis from PostgreSQL before worker loops
    worker::warm_redis_from_postgres(&app_state).await;
    worker::warm_list_caches(&app_state).await;

    tokio::spawn(worker::run_metrics_worker(app_state.clone()));
    tokio::spawn(modules::scheduler::run_module_scheduler(app_state.clone()));

    let cors = {
        let origin = std::env::var("CORS_ORIGIN").unwrap_or_default();
        let layer = CorsLayer::new()
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any);
        if origin.is_empty() {
            warn!("CORS_ORIGIN not set — allowing all origins. Set CORS_ORIGIN to restrict access.");
            layer.allow_origin(tower_http::cors::Any)
        } else {
            let allowed: Vec<AxumHeaderValue> = origin
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();
            layer.allow_origin(AllowOrigin::list(allowed))
        }
    };

    let api = Router::new()
        .merge(routes::health::router(app_state.clone()))
        .merge(routes::auth::router(app_state.clone()))
        .merge(routes::settings::router(app_state.clone()))
        .merge(routes::pools::router(app_state.clone()))
        .merge(routes::datasets::router(app_state.clone()))
        .merge(routes::snapshots::router(app_state.clone()))
        .merge(routes::stats::router(app_state.clone()))
        .merge(routes::volumes::router(app_state.clone()))
        .merge(routes::clones::router())
        .merge(routes::properties::router())
        .merge(routes::metrics::router(app_state.clone()))
        .merge(routes::layout::router(app_state.clone()))
        .merge(routes::notifications::router(app_state.clone()))
        .merge(routes::module_store::router(app_state.clone()))
        .merge(routes::modules::router(app_state.clone()))
        .merge(routes::custom_tabs::router(app_state.clone()))
        .layer(middleware::from_fn_with_state(app_state.clone(), auth_middleware));

    // Serve the built frontend from the same process (single-container setup).
    // Unknown paths fall back to index.html for client-side routing.
    let static_dir = std::env::var("ZFS_STATIC_DIR")
        .unwrap_or_else(|_| "/usr/share/zfs-dashboard/web".to_string());
    let index_path = std::path::Path::new(&static_dir).join("index.html");
    let app = match std::fs::read_to_string(&index_path) {
        Ok(index_html) => {
            info!("Serving frontend from {static_dir}");
            // Unknown non-file paths (SPA client routes) get index.html.
            let spa_fallback = axum::routing::get(move || {
                let html = index_html.clone();
                async move { axum::response::Html(html) }
            });
            api.fallback_service(
                tower_http::services::ServeDir::new(&static_dir).fallback(spa_fallback),
            )
        }
        Err(_) => {
            info!("No frontend found at {static_dir} — serving API only");
            api
        }
    };
    let app = app
        .layer(middleware::from_fn(security_headers))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("Failed to bind port");

    info!("zfs-dashboard service listening on http://0.0.0.0:{port}");
    info!("   API base: http://0.0.0.0:{port}/api/v1");
    if std::env::var("ZFS_API_KEY").is_ok() {
        info!("API Key Authentication enabled!");
    } else {
        info!("API Key is NOT set. API is accessible to everyone.");
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");
}
