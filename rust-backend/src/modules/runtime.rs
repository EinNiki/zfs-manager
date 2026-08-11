use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio_postgres::Client;
use tracing::{info, warn};
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{Engine, Store, StoreLimits, StoreLimitsBuilder};

wasmtime::component::bindgen!({
    path: "wit",
    world: "module",
    imports: { default: async },
    exports: { default: async },
});

use super::net;
use zfs_dashboard::module::host_api::{Host, HttpResponse};

/// Per-run resource limits, enforced by the host.
#[derive(Debug, Clone)]
pub struct RunLimits {
    /// Instruction budget (wasmtime fuel).
    pub fuel: u64,
    /// Linear memory cap in bytes.
    pub memory_bytes: usize,
    /// Wall-clock timeout.
    pub timeout: Duration,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            fuel: default_env("ZFS_MODULE_FUEL", 2_000_000_000),
            memory_bytes: default_env("ZFS_MODULE_MEMORY_BYTES", 64 * 1024 * 1024),
            timeout: Duration::from_secs(default_env("ZFS_MODULE_TIMEOUT_SECS", 30)),
        }
    }
}

fn default_env<T: std::str::FromStr + Copy>(var: &str, fallback: T) -> T {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

const MAX_HTTP_REQUESTS_PER_RUN: u32 = 32;
const MAX_HTTP_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MAX_METRICS_PER_RUN: u32 = 1000;
const MAX_LOG_LINES: usize = 500;
const MAX_LOG_LINE_BYTES: usize = 2048;
const EPOCH_TICK: Duration = Duration::from_millis(100);

/// Everything a running module is allowed to touch.
pub struct ModuleCtx {
    pub module_id: String,
    /// Effective host allowlist: manifest entries + hosts of url-type config values.
    pub allowlist: Vec<String>,
    pub secrets: HashMap<String, String>,
    pub pg: Option<Arc<Client>>,
    pub config_json: String,
    /// Internal auth token injected into all module HTTP requests so the
    /// dashboard's own auth middleware can recognize and allow them.
    pub internal_token: String,
}

/// What the host records after a run.
#[derive(Debug)]
pub struct RunOutcome {
    pub success: bool,
    pub message: String,
    pub metrics_written: u32,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

struct HostState {
    ctx: ModuleCtx,
    http: reqwest::Client,
    http_requests: u32,
    metrics_written: u32,
    logs: Vec<String>,
    limits: StoreLimits,
    /// Locked-down WASI context: no filesystem, no sockets, no env, no stdio.
    wasi: wasmtime_wasi::WasiCtx,
    table: wasmtime::component::ResourceTable,
}

impl wasmtime_wasi::WasiView for HostState {
    fn ctx(&mut self) -> wasmtime_wasi::WasiCtxView<'_> {
        wasmtime_wasi::WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl HostState {
    fn push_log(&mut self, level: &str, message: &str) {
        if self.logs.len() >= MAX_LOG_LINES {
            return;
        }
        let mut msg = net::sanitize_log(message);
        net::truncate_on_char_boundary(&mut msg, MAX_LOG_LINE_BYTES);
        self.logs.push(format!("[{level}] {msg}"));
    }
}

impl HostState {
    /// Shared request logic: allowlist + SSRF check, send, read response.
    async fn do_request(
        &mut self,
        method: reqwest::Method,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    ) -> Result<HttpResponse, String> {
        self.http_requests += 1;
        if self.http_requests > MAX_HTTP_REQUESTS_PER_RUN {
            return Err(format!("request limit ({MAX_HTTP_REQUESTS_PER_RUN}) exceeded"));
        }
        let parsed = net::check_allowlist(&url, &self.ctx.allowlist)?;
        net::reject_dangerous_ip(&parsed).await?;

        let mut request = self.http.request(method, parsed);
        // Inject internal auth token so the dashboard's own auth middleware
        // recognizes requests from the WASM sandbox and allows them through.
        // This lets modules call dashboard API endpoints (e.g. /api/v1/disks)
        // without needing a user-provided API key or session token.
        request = request.header("X-Internal-Module", &self.ctx.internal_token);
        for (name, value) in headers {
            request = request.header(name.as_str(), value.as_str());
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = response.status().as_u16();

        let mut buf = Vec::new();
        let mut stream = response;
        while let Some(chunk) = stream.chunk().await.map_err(|e| e.to_string())? {
            buf.extend_from_slice(&chunk);
            if buf.len() > MAX_HTTP_RESPONSE_BYTES {
                return Err(format!("response exceeds {MAX_HTTP_RESPONSE_BYTES} bytes"));
            }
        }
        Ok(HttpResponse {
            status,
            body: String::from_utf8_lossy(&buf).into_owned(),
        })
    }
}

impl Host for HostState {
    async fn http_fetch(
        &mut self,
        url: String,
        headers: Vec<(String, String)>,
    ) -> Result<HttpResponse, String> {
        self.do_request(reqwest::Method::GET, url, headers, None).await
    }

    async fn http_request(
        &mut self,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    ) -> Result<HttpResponse, String> {
        let method = match method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            "DELETE" => reqwest::Method::DELETE,
            other => return Err(format!("unsupported HTTP method: {other}")),
        };
        self.do_request(method, url, headers, body).await
    }

    async fn db_write_metric(&mut self, metric_name: String, value: f64) -> Result<(), String> {
        if self.metrics_written >= MAX_METRICS_PER_RUN {
            return Err(format!("metric limit ({MAX_METRICS_PER_RUN}) exceeded"));
        }
        if metric_name.is_empty()
            || metric_name.len() > 128
            || !metric_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err("metric name must be 1-128 chars of [a-zA-Z0-9._-]".into());
        }
        if !value.is_finite() {
            return Err("metric value must be finite".into());
        }
        let pg = self.ctx.pg.as_ref().ok_or("database unavailable")?;
        pg.execute(
            "INSERT INTO module_metrics(module_id, metric_name, value) VALUES($1, $2, $3)",
            &[&self.ctx.module_id, &metric_name, &value],
        )
        .await
        .map_err(|e| {
            warn!("module {}: metric insert failed: {e}", self.ctx.module_id);
            "metric insert failed".to_string()
        })?;
        self.metrics_written += 1;
        Ok(())
    }

    async fn get_secret(&mut self, key: String) -> Option<String> {
        self.ctx.secrets.get(&key).cloned()
    }

    async fn log(&mut self, level: String, message: String) {
        let level = match level.as_str() {
            "trace" | "debug" | "info" | "warn" | "error" => level,
            _ => "info".to_string(),
        };
        info!("module {} [{level}]: {message}", self.ctx.module_id);
        self.push_log(&level, &message);
    }
}

/// Shared Wasm engine. Create once, reuse for every run.
pub struct ModuleRuntime {
    engine: Engine,
    http: reqwest::Client,
}

impl ModuleRuntime {
    pub fn new() -> Result<Self, String> {
        let mut config = wasmtime::Config::new();
        config
            .consume_fuel(true)
            .epoch_interruption(true)
            .wasm_component_model(true);
        let engine = Engine::new(&config).map_err(|e| e.to_string())?;

        // Epoch ticker: one background thread drives wall-clock deadlines for
        // all runs. Exits when the engine is dropped.
        let weak = engine.weak();
        std::thread::spawn(move || loop {
            std::thread::sleep(EPOCH_TICK);
            match weak.upgrade() {
                Some(engine) => engine.increment_epoch(),
                None => break,
            }
        });

        // Redirects are disabled so a redirect can't escape the allowlist.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;

        Ok(Self { engine, http })
    }

    /// Validates that the bytes are a compilable component exporting `run`.
    pub fn validate_component(&self, wasm: &[u8]) -> Result<(), String> {
        Component::new(&self.engine, wasm)
            .map(|_| ())
            .map_err(|e| format!("not a valid module component: {e}"))
    }

    /// Executes one module run inside the sandbox.
    pub async fn run(&self, wasm: &[u8], ctx: ModuleCtx, limits: &RunLimits) -> RunOutcome {
        let module_id = ctx.module_id.clone();
        match self.run_inner(wasm, ctx, limits).await {
            Ok(outcome) => outcome,
            Err(e) => {
                warn!("module {module_id}: run aborted: {e}");
                RunOutcome {
                    success: false,
                    message: String::new(),
                    metrics_written: 0,
                    error: Some(e),
                    logs: Vec::new(),
                }
            }
        }
    }

    async fn run_inner(
        &self,
        wasm: &[u8],
        ctx: ModuleCtx,
        limits: &RunLimits,
    ) -> Result<RunOutcome, String> {
        let component =
            Component::new(&self.engine, wasm).map_err(|e| format!("component compile failed: {e}"))?;

        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        Module::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
            .map_err(|e| format!("linker setup failed: {e}"))?;
        // WASI base for the guest's std: everything stays denied — no
        // preopened dirs, no sockets, no env, no stdio inheritance.
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(|e| format!("wasi linker setup failed: {e}"))?;

        let config_json = ctx.config_json.clone();
        let state = HostState {
            ctx,
            http: self.http.clone(),
            http_requests: 0,
            metrics_written: 0,
            logs: Vec::new(),
            limits: StoreLimitsBuilder::new()
                .memory_size(limits.memory_bytes)
                .memories(4)
                .tables(16)
                .instances(4)
                .build(),
            wasi: wasmtime_wasi::WasiCtxBuilder::new().build(),
            table: wasmtime::component::ResourceTable::new(),
        };

        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);
        store.set_fuel(limits.fuel).map_err(|e| e.to_string())?;
        let ticks = (limits.timeout.as_millis() / EPOCH_TICK.as_millis()).max(1) as u64 + 1;
        store.set_epoch_deadline(ticks);

        let instance = Module::instantiate_async(&mut store, &component, &linker)
            .await
            .map_err(|e| format!("instantiation failed: {e}"))?;

        // Epoch deadline + fuel already bound the run; the outer timeout is a
        // backstop in case a host call (HTTP, DB) hangs past the deadline.
        let backstop = limits.timeout + Duration::from_secs(20);
        let result = tokio::time::timeout(backstop, instance.call_run(&mut store, &config_json)).await;

        let state = store.into_data();
        match result {
            Ok(Ok(run)) => Ok(RunOutcome {
                success: run.success,
                message: run.message,
                metrics_written: state.metrics_written,
                error: run.error,
                logs: state.logs,
            }),
            Ok(Err(trap)) => Ok(RunOutcome {
                success: false,
                message: String::new(),
                metrics_written: state.metrics_written,
                error: Some(classify_trap(&trap)),
                logs: state.logs,
            }),
            Err(_) => Ok(RunOutcome {
                success: false,
                message: String::new(),
                metrics_written: state.metrics_written,
                error: Some("timeout: run exceeded the wall-clock limit".into()),
                logs: state.logs,
            }),
        }
    }
}

fn classify_trap(error: &wasmtime::Error) -> String {
    let text = format!("{error:#}");
    if text.contains("fuel") {
        "aborted: instruction limit (fuel) exhausted".to_string()
    } else if text.contains("epoch") || text.contains("interrupt") {
        "timeout: wall-clock limit exceeded".to_string()
    } else if text.contains("memory") || text.contains("limit") {
        "aborted: memory limit exceeded".to_string()
    } else {
        format!("module trapped: {text}")
    }
}
