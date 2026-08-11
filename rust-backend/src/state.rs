use std::sync::Arc;
use std::sync::Mutex;
use std::collections::HashMap;
use std::time::Instant;
use std::sync::atomic::AtomicU64;
use tokio_postgres::Client;
use redis::aio::ConnectionManager;

pub type RateLimitMap = Arc<Mutex<HashMap<String, Vec<Instant>>>>;

/// Per-physical-disk metrics from a single iostat sample.
#[derive(Clone, Debug, Default)]
pub struct DiskMetric {
    pub name: String,
    pub read_bw_mb: f64,
    pub write_bw_mb: f64,
    pub read_iops: f64,
    pub write_iops: f64,
    /// Cumulative bytes read/written accumulated from 1-second deltas since process start.
    pub total_read_gb: f64,
    pub total_write_gb: f64,
}

/// In-memory cache of the most recent iostat measurement.
/// Written by the 1s slow loop; read by the 1s fast loop (no syscall).
#[derive(Clone, Debug, Default)]
pub struct CachedIoSnapshot {
    /// Pool-aggregated bandwidth / IOPS (summed across all active pools)
    pub read_bw_mb: f64,
    pub write_bw_mb: f64,
    pub read_iops: f64,
    pub write_iops: f64,
    /// Per-pool leaf-disk breakdown: pool_name → disks
    pub pool_disks: HashMap<String, Vec<DiskMetric>>,
}

/// Running per-disk byte totals: pool_name → disk_name → (read_bytes, write_bytes).
/// Accumulated from 1-second I/O deltas by the slow loop.
pub type DiskCumulative = Arc<tokio::sync::RwLock<HashMap<String, HashMap<String, (u64, u64)>>>>;

#[derive(Clone)]
pub struct AppState {
    pub redis: Option<ConnectionManager>,
    pub pg: Option<Arc<Client>>,
    pub rate_limit: RateLimitMap,
    /// Shared Wasm engine for the module system.
    pub module_runtime: Option<Arc<crate::modules::runtime::ModuleRuntime>>,
    /// AES-256 master key for module secrets.
    pub master_key: Option<[u8; 32]>,
    pub total_read_bytes: Arc<AtomicU64>,
    pub total_write_bytes: Arc<AtomicU64>,
    /// Shared iostat cache between the fast loop and the 1s slow loop.
    pub io_cache: Arc<tokio::sync::RwLock<CachedIoSnapshot>>,
    /// Per-disk running byte totals used for the "Total Read / Total Write" columns.
    pub disk_cumulative: DiskCumulative,
    /// Random token injected into all module HTTP requests so the auth
    /// middleware can recognize internal requests from the WASM sandbox
    /// and bypass session/API-key auth. Generated once at startup.
    pub internal_module_token: Arc<String>,
}
