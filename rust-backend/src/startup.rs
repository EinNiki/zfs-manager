use std::fs;
use std::process::Command;
use tracing::{info, warn, error};

/// Application data directory. Hardcoded to `/app`; the entrypoint migrates
/// data from legacy paths automatically so no env var is needed.
pub fn data_dir() -> String {
    "/app".to_string()
}

/// Mount all ZFS datasets from already-imported pools so that the rshared /mnt
/// bind-mount propagates them back to the host filesystem.
pub async fn run_startup_zfs_mount() {
    match tokio::process::Command::new("zfs")
        .args(["mount", "-a"])
        .output()
        .await
    {
        Ok(out) if out.status.success() => {
            info!("✅ ZFS: all datasets mounted (rshared propagation active)");
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // "already mounted" is normal when pool was mounted before container start
            if stderr.lines().all(|l| l.contains("already mounted") || l.trim().is_empty()) {
                info!("✅ ZFS: datasets already mounted");
            } else {
                warn!("⚠️ ZFS mount -a: {}", stderr.trim());
            }
        }
        Err(e) => warn!("⚠️ ZFS mount -a failed: {}", e),
    }
}

pub async fn run_startup_pool_imports() {
    use crate::routes::pools::{load_import_configs, execute_pool_import};

    let configs = load_import_configs();
    let startup_configs: Vec<_> = configs.into_iter()
        .filter(|c| c.enabled && c.import_on_startup)
        .collect();

    if startup_configs.is_empty() {
        return;
    }

    info!("Running {} startup pool import(s)...", startup_configs.len());
    for config in &startup_configs {
        info!("  → Importing pool '{}'...", config.name);
        match execute_pool_import(config).await {
            Ok(_) => info!("  ✅ Pool '{}' import completed", config.name),
            Err(e) => error!("  ❌ Pool '{}' import failed: {:?}", config.name, e),
        }
    }
}

pub async fn run_startup_checks() {
    info!("🚀 Starting ZFS Dashboard Diagnostic Checks...");

    // ─── System Access ──────────────────────────────────────────────────────────
    info!("--- System Resources ---");
    
    // 1. Check Binaries
    let binaries = ["zfs", "zpool", "smartctl", "lsblk"];
    for bin in binaries {
        match Command::new(bin).arg("--version").output() {
            Ok(_) => info!("  ✅ Binary found: {}", bin),
            Err(_) => error!("  ❌ Binary NOT found: {}. Some features will fail!", bin),
        }
    }

    // 2. Check ZFS Kernel Device
    let zfs_dev = "/dev/zfs";
    if fs::metadata(zfs_dev).is_ok() {
        match fs::OpenOptions::new().read(true).write(true).open(zfs_dev) {
            Ok(_) => info!("  ✅ Device access: {} is Read/Write", zfs_dev),
            Err(_) => {
                // Try read only if RW fails
                if fs::OpenOptions::new().read(true).open(zfs_dev).is_ok() {
                    warn!("  ⚠️ Device access: {} is READ-ONLY. Management tasks might fail!", zfs_dev);
                } else {
                    error!("  ❌ Device access: {} is NOT accessible.", zfs_dev);
                }
            }
        }
    } else {
        error!("  ❌ Device NOT found: {}. ZFS management will NOT work!", zfs_dev);
    }

    // 3. Check /proc entries
    let proc_files = [
        "/proc/stat",
        "/proc/meminfo",
        "/proc/loadavg",
        "/proc/uptime",
        "/proc/spl/kstat/zfs/arcstats",
    ];
    for file in proc_files {
        match fs::read_to_string(file) {
            Ok(_) => info!("  ✅ ProcFS: {} is readable", file),
            Err(e) => warn!("  ⚠️ ProcFS: {} is NOT readable ({})", file, e),
        }
    }

    // 4. Check Storage
    let data_dir = data_dir();
    let test_file = format!("{}/.startup_test", data_dir);
    if fs::create_dir_all(&data_dir).is_ok() && fs::write(&test_file, "test").is_ok() {
        info!("  ✅ Storage: {} is writable", data_dir);
        let _ = fs::remove_file(&test_file);
    } else {
        error!("  ❌ Storage: {} is NOT writable!", data_dir);
    }

    // ─── Service Connectivity ──────────────────────────────────────────────────
    info!("--- Infrastructure Connectivity ---");

    // 5. Check Redis
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    match redis::Client::open(redis_url.as_str()) {
        Ok(client) => {
            match client.get_connection() {
                Ok(_) => info!("  ✅ Redis: Connected successfully to {}", redis_url),
                Err(e) => error!("  ❌ Redis: Could not connect to {} ({})", redis_url, e),
            }
        }
        Err(e) => error!("  ❌ Redis: Invalid URL {} ({})", redis_url, e),
    }

    // 6. Check PostgreSQL
    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://zfs:zfs_secret@127.0.0.1:5432/zfs_metrics".to_string());
    match tokio_postgres::connect(&db_url, tokio_postgres::NoTls).await {
        Ok(_) => info!("  ✅ PostgreSQL: Connected successfully"),
        Err(e) => error!("  ❌ PostgreSQL: Could not connect ({})", e),
    }

    info!("🏁 Diagnostic Checks finished.");
}
