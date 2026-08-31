use std::sync::atomic::Ordering;
use redis::AsyncCommands;
use tokio::time::{interval, Duration, Instant, MissedTickBehavior};
use tracing::{info, warn};
use cron::Schedule;
use chrono::Local;
use std::str::FromStr;

use crate::state::DiskMetric;

async fn check_and_trigger_notifications(state: &crate::state::AppState) {
    let pg = match &state.pg {
        Some(pg) => pg,
        None => return,
    };

    let (read_bw_mb, write_bw_mb, read_iops, write_iops) = {
        let cache = state.io_cache.read().await;
        (cache.read_bw_mb, cache.write_bw_mb, cache.read_iops, cache.write_iops)
    };

    let live_types: Vec<String> = ["iops_high", "read_iops_high", "write_iops_high",
                                    "read_bw_high", "write_bw_high", "capacity"]
        .iter().map(|s| s.to_string()).collect();

    let rows = match pg.query(
        "SELECT name, trigger_type, threshold_value, channel_ids \
         FROM notification_rules WHERE is_active = true AND trigger_type = ANY($1)",
        &[&live_types],
    ).await {
        Ok(r) => r,
        Err(e) => { warn!("Notification rule query failed: {e}"); return; }
    };

    if rows.is_empty() { return; }

    // Batch-fetch all referenced channels once (fixes N+1)
    let all_channel_ids: Vec<i32> = {
        let mut seen = std::collections::HashSet::new();
        for row in &rows {
            let ids: Vec<i32> = row.get(3);
            seen.extend(ids);
        }
        seen.into_iter().collect()
    };

    let ch_map: std::collections::HashMap<i32, (String, serde_json::Value)> =
        if all_channel_ids.is_empty() {
            std::collections::HashMap::new()
        } else {
            match pg.query(
                "SELECT id, type, config FROM notification_channels WHERE id = ANY($1)",
                &[&all_channel_ids],
            ).await {
                Ok(ch_rows) => ch_rows.iter().map(|r| {
                    (r.get::<_, i32>(0), (r.get::<_, String>(1), r.get::<_, serde_json::Value>(2)))
                }).collect(),
                Err(e) => { warn!("Channel batch query failed: {e}"); return; }
            }
        };

    // Fetch pool capacity once if any capacity rules exist
    let has_capacity = rows.iter().any(|r| { let tt: String = r.get(1); tt == "capacity" });
    let pool_caps: Vec<(String, f64, f64)> = if has_capacity {
        let mut caps = Vec::new();
        for pool in get_pool_names().await {
            if let Some((alloc, free)) = get_pool_capacity(&pool).await {
                caps.push((pool, alloc, free));
            }
        }
        caps
    } else {
        vec![]
    };

    for row in &rows {
        let rule_name: String     = row.get(0);
        let trigger_type: String  = row.get(1);
        let threshold: Option<f64> = row.get(2);
        let channel_ids: Vec<i32> = row.get(3);

        let threshold = match threshold { Some(t) => t, None => continue };

        // Build (trigger_type_str, message) pairs for each threshold breach
        let alerts: Vec<(String, String)> = match trigger_type.as_str() {
            "iops_high" => {
                let v = read_iops + write_iops;
                if v >= threshold {
                    vec![(trigger_type.clone(), format!("Total IOPS {:.0} exceeds threshold {:.0}", v, threshold))]
                } else { vec![] }
            }
            "read_iops_high" => {
                if read_iops >= threshold {
                    vec![(trigger_type.clone(), format!("Read IOPS {:.0} exceeds threshold {:.0}", read_iops, threshold))]
                } else { vec![] }
            }
            "write_iops_high" => {
                if write_iops >= threshold {
                    vec![(trigger_type.clone(), format!("Write IOPS {:.0} exceeds threshold {:.0}", write_iops, threshold))]
                } else { vec![] }
            }
            "read_bw_high" => {
                if read_bw_mb >= threshold {
                    vec![(trigger_type.clone(), format!("Read bandwidth {:.1} MB/s exceeds threshold {:.1} MB/s", read_bw_mb, threshold))]
                } else { vec![] }
            }
            "write_bw_high" => {
                if write_bw_mb >= threshold {
                    vec![(trigger_type.clone(), format!("Write bandwidth {:.1} MB/s exceeds threshold {:.1} MB/s", write_bw_mb, threshold))]
                } else { vec![] }
            }
            "capacity" => {
                pool_caps.iter().filter_map(|(pool, alloc, free)| {
                    let total = alloc + free;
                    if total > 0.0 {
                        let used_pct = (alloc / total) * 100.0;
                        if used_pct >= threshold {
                            Some((trigger_type.clone(),
                                format!("Pool '{}' at {:.1}% capacity (threshold: {:.0}%)", pool, used_pct, threshold)))
                        } else { None }
                    } else { None }
                }).collect()
            }
            _ => vec![],
        };

        for (ttype, msg) in alerts {
            let full_msg = format!("[Rule: {}] {}", rule_name, msg);
            let level = "warning";
            let _ = pg.execute(
                "INSERT INTO notifications (type, message, level) VALUES ($1, $2, $3)",
                &[&ttype, &full_msg, &level],
            ).await;

            for ch_id in &channel_ids {
                if let Some((ctype, config)) = ch_map.get(ch_id) {
                    if let Err(e) = crate::routes::notifications::dispatch_notification(ctype, config, &full_msg).await {
                        warn!("Notification dispatch failed for channel {ch_id}: {e}");
                    }
                }
            }
        }
    }
}

fn read_cpu_jiffies() -> (u64, u64) {
    let content = std::fs::read_to_string("/proc/stat").unwrap_or_default();
    for line in content.lines() {
        if line.starts_with("cpu ") {
            let vals: Vec<u64> = line
                .split_whitespace()
                .skip(1)
                .map(|s| s.parse().unwrap_or(0))
                .collect();
            let user = vals.first().copied().unwrap_or(0);
            let nice = vals.get(1).copied().unwrap_or(0);
            let system = vals.get(2).copied().unwrap_or(0);
            let idle = vals.get(3).copied().unwrap_or(0);
            let iowait = vals.get(4).copied().unwrap_or(0);
            let irq = vals.get(5).copied().unwrap_or(0);
            let softirq = vals.get(6).copied().unwrap_or(0);
            let steal = vals.get(7).copied().unwrap_or(0);
            
            // Do not sum all values because guest (8) and guest_nice (9) are already included in user and nice.
            let total = user + nice + system + idle + iowait + irq + softirq + steal;
            let idle_time = idle + iowait;
            return (total, idle_time);
        }
    }
    (0, 0)
}

fn read_arc_hit_ratio() -> f64 {
    let raw = std::fs::read_to_string("/proc/spl/kstat/zfs/arcstats").unwrap_or_default();
    let mut hits: u64 = 0;
    let mut misses: u64 = 0;
    for line in raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            match parts[0] {
                "hits"   => hits   = parts[2].parse().unwrap_or(0),
                "misses" => misses = parts[2].parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    let total = hits + misses;
    if total > 0 { (hits as f64 / total as f64) * 100.0 } else { 0.0 }
}

async fn get_pool_names() -> Vec<String> {
    let output = tokio::process::Command::new("zpool")
        .args(["list", "-H", "-o", "name"])
        .output()
        .await;
    match output {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        Ok(out) => {
            warn!("zpool list failed: {}", String::from_utf8_lossy(&out.stderr).trim());
            vec![]
        }
        Err(e) => {
            warn!("zpool command not found or failed: {e}");
            vec![]
        }
    }
}

// Vdev group type prefixes — lines starting with these are NOT leaf disks.
const VDEV_GROUP_PREFIXES: &[&str] = &[
    "mirror", "raidz", "draid", "spare", "log", "cache",
    "replacing", "removed", "indirect",
];

fn is_vdev_group(name: &str) -> bool {
    VDEV_GROUP_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Strips trailing partition digits from a list of device names when the suffix is unambiguous.
/// "sdc1" → "sdc"  only when no "sdc2" (or "sdc3", …) is present in the same list.
/// If both "sdc1" and "sdc2" exist, both names are kept as-is.
/// Used by both the iostat disk list and the pool_vdevs route.
pub fn strip_partition_suffix_list(names: &mut [String]) {
    let bases: Vec<String> = names.iter().filter_map(|n| {
        let b = n.trim_end_matches(|c: char| c.is_ascii_digit());
        if b.len() < n.len() { Some(b.to_string()) } else { None }
    }).collect();
    let mut base_count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for b in &bases {
        *base_count.entry(b.as_str()).or_insert(0) += 1;
    }
    for name in names.iter_mut() {
        let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
        if base.len() < name.len() && base_count.get(base).copied().unwrap_or(0) == 1 {
            *name = base.to_string();
        }
    }
}

fn strip_partition_suffix(disks: &mut [crate::state::DiskMetric]) {
    let mut names: Vec<String> = disks.iter().map(|d| d.name.clone()).collect();
    strip_partition_suffix_list(&mut names);
    for (disk, name) in disks.iter_mut().zip(names) {
        disk.name = name;
    }
}

/// Resolves a raw disk name from zpool iostat output to a short kernel device name.
///
/// zpool may report disks as:
/// - SCSI-ID symlinks:  scsi-0QEMU_QEMU_HARDDISK_drive-scsi0
/// - Full paths:        /dev/sda, /dev/disk/by-id/...
/// - Already short:     sda, sdb, loop10, nvme0n1
///
/// Strategy (in order):
/// 1. Already a short device name (no path separator, no common ID prefix) → return as-is.
/// 2. /dev/disk/by-id/{name} exists → readlink → basename.
/// 3. lsblk -no name {resolved_path} → first line.
/// 4. Strip well-known ID prefixes (scsi-, ata-, wwn-, usb-) → take remainder up to first '-' … → last dash segment.
/// 5. Final fallback: last path component of the name.
pub async fn resolve_disk_short_name(name: &str) -> String {
    // Already a short name (no '/', no ID-style prefix)?
    if !name.contains('/')
        && !name.starts_with("scsi-")
        && !name.starts_with("ata-")
        && !name.starts_with("wwn-")
        && !name.starts_with("usb-")
        && !name.starts_with("nvme-eui.")
    {
        return name.to_string();
    }

    // Try /dev/disk/by-id/ symlink resolution.
    let by_id = format!("/dev/disk/by-id/{}", name);
    if tokio::fs::metadata(&by_id).await.is_ok() {
        if let Ok(target) = tokio::fs::read_link(&by_id).await {
            let short = target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if !short.is_empty() {
                return short;
            }
        }
    }

    // If it's a full path, try lsblk on it.
    let dev_path = if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/dev/{}", name)
    };
    if tokio::fs::metadata(&dev_path).await.is_ok() {
        let out = tokio::process::Command::new("lsblk")
            .args(["-no", "name", &dev_path])
            .output()
            .await;
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            let first = s.lines().next().unwrap_or("").trim().to_string();
            if !first.is_empty() {
                return first;
            }
        }
    }

    // Strip common SCSI/ATA/WWN ID prefixes and take the final dash-separated segment.
    let stripped = name
        .trim_start_matches("scsi-")
        .trim_start_matches("ata-")
        .trim_start_matches("wwn-")
        .trim_start_matches("usb-")
        .trim_start_matches("nvme-eui.");
    // Heuristic: if the stripped ID ends with _drive-sdX style, grab that suffix.
    if let Some(pos) = stripped.rfind("_drive-") {
        let suffix = &stripped[pos + 7..]; // after "_drive-"
        if !suffix.is_empty() {
            return suffix.to_string();
        }
    }
    // Last path component as final fallback.
    name.rsplit('/').next().unwrap_or(name).to_string()
}

/// Returned by get_pool_iostat_with_disks.
struct IostatResult {
    alloc_gb: f64,
    free_gb: f64,
    iops: f64,
    read_bw_mb: f64,
    write_bw_mb: f64,
    read_bw_bytes: f64,
    write_bw_bytes: f64,
    read_iops: f64,
    write_iops: f64,
    disks: Vec<DiskMetric>,
}

/// Runs `zpool iostat -v -H -p <pool> 1 2` (takes ~1 s).
/// Parses both pool-level summary and individual leaf-disk metrics.
/// `zpool iostat ... 1 2` emits two samples; for live bandwidth/IOPS we use the later
/// sample, which reflects the interval-based rates after the 1-second wait.
/// Cumulative read/write totals are not taken from the first iostat block here; they are
/// computed separately from pool statistics rather than from this command's rate output.
async fn get_pool_iostat_with_disks(pool: &str) -> Option<IostatResult> {
    let output = tokio::process::Command::new("zpool")
        .args(["iostat", "-v", "-H", "-p", pool, "1", "2"])
        .output()
        .await;

    let out = match output {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            warn!("zpool iostat -v failed for {pool}: {}", String::from_utf8_lossy(&o.stderr).trim());
            return None;
        }
        Err(e) => {
            warn!("zpool iostat -v error for {pool}: {e}");
            return None;
        }
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    let all_lines: Vec<&str> = stdout.lines()
        .filter(|l| !l.trim().is_empty())
        .collect();

    if all_lines.is_empty() { return None; }

    // Locate the two pool-level lines (first tab-field == pool name).
    let pool_line_pos = |start: usize| -> Option<usize> {
        all_lines[start..].iter().position(|l| {
            l.split('\t').next().map(|s| s.trim()) == Some(pool)
        }).map(|rel| start + rel)
    };
    let first_block_start  = pool_line_pos(0)?;
    let second_block_start = pool_line_pos(first_block_start + 1).unwrap_or(first_block_start);

    // ── Second block: 1s delta — pool summary + per-disk rates ────────────────
    // (The first block shows average bandwidth RATES since pool import, not
    // cumulative byte totals — per-disk totals are accumulated in run_slow_loop.)
    let second_block = &all_lines[second_block_start..];
    if second_block.is_empty() { return None; }

    let pool_line = second_block[0];
    let cols: Vec<&str> = pool_line.split('\t').collect();
    if cols.len() < 7 { return None; }

    let alloc_bytes: f64    = cols[1].parse().unwrap_or(0.0);
    let free_bytes: f64     = cols[2].parse().unwrap_or(0.0);
    let read_ops: f64       = cols[3].parse().unwrap_or(0.0);
    let write_ops: f64      = cols[4].parse().unwrap_or(0.0);
    let read_bw_bytes: f64  = cols[5].parse().unwrap_or(0.0);
    let write_bw_bytes: f64 = cols[6].parse().unwrap_or(0.0);

    let mut disks: Vec<DiskMetric> = Vec::new();
    for line in second_block.iter().skip(1) {
        let trimmed = line.trim_start();
        let dcols: Vec<&str> = trimmed.splitn(8, '\t').collect();
        if dcols.len() < 7 { continue; }

        let raw_name = dcols[0].trim().to_string();
        if raw_name.is_empty() || raw_name == pool || is_vdev_group(&raw_name) { continue; }
        let name = resolve_disk_short_name(&raw_name).await;

        let parse = |s: &str| -> f64 { s.parse().unwrap_or(0.0) };
        let d_read_ops:  f64 = parse(dcols[3]);
        let d_write_ops: f64 = parse(dcols[4]);
        let d_read_bw:   f64 = parse(dcols[5]);
        let d_write_bw:  f64 = parse(dcols[6]);

        // total_read_gb / total_write_gb are filled by run_slow_loop from the
        // per-disk accumulator; leave at 0.0 here.
        disks.push(DiskMetric {
            name,
            read_bw_mb:    d_read_bw  / 1_048_576.0,
            write_bw_mb:   d_write_bw / 1_048_576.0,
            read_iops:     d_read_ops,
            write_iops:    d_write_ops,
            total_read_gb:  0.0,
            total_write_gb: 0.0,
        });
    }

    // Strip partition suffixes when unambiguous: sdc1 → sdc only if no sdc2 exists.
    strip_partition_suffix(&mut disks);

    Some(IostatResult {
        alloc_gb:      alloc_bytes  / 1_073_741_824.0,
        free_gb:       free_bytes   / 1_073_741_824.0,
        iops:          read_ops + write_ops,
        read_bw_mb:    read_bw_bytes  / 1_048_576.0,
        write_bw_mb:   write_bw_bytes / 1_048_576.0,
        read_bw_bytes,
        write_bw_bytes,
        read_iops:     read_ops,
        write_iops:    write_ops,
        disks,
    })
}

/// Returns (used_gb, available_gb) using `zfs get available,used` — the same
/// logical values shown by the Dashboard "Available Space" card.
async fn get_pool_capacity(pool: &str) -> Option<(f64, f64)> {
    let output = tokio::process::Command::new("zfs")
        .args(["get", "-H", "-p", "-o", "property,value", "available,used", pool])
        .output()
        .await;

    let out = match output {
        Ok(o) if o.status.success() => o,
        _ => return None,
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut available: f64 = 0.0;
    let mut used: f64 = 0.0;
    for line in stdout.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 { continue; }
        match cols[0] {
            "available" => available = cols[1].parse().unwrap_or(0.0),
            "used"      => used      = cols[1].parse().unwrap_or(0.0),
            _ => {}
        }
    }
    if available == 0.0 && used == 0.0 { return None; }
    // Return (alloc_gb, free_gb) to match the existing callers' expectations
    Some((used / 1_073_741_824.0, available / 1_073_741_824.0))
}

async fn push_to_redis(
    redis: &mut redis::aio::ConnectionManager,
    key_pending: &str,
    key_latest: &str,
    payload: &str,
) {
    let rpush_result: redis::RedisResult<i64> = redis.rpush(key_pending, payload).await;
    if let Err(e) = rpush_result {
        warn!("Redis RPUSH failed: {e}");
        return;
    }
    let ltrim_result: redis::RedisResult<()> = redis.ltrim(key_pending, -2000, -1).await;
    if let Err(e) = ltrim_result {
        warn!("Redis LTRIM failed: {e}");
    }
    let set_result: redis::RedisResult<()> = redis.set_ex(key_latest, payload, 30u64).await;
    if let Err(e) = set_result {
        warn!("Redis SET failed for latest key: {e}");
    }
}

async fn sync_redis_to_postgres(
    redis: &mut redis::aio::ConnectionManager,
    pg: &tokio_postgres::Client,
    key_pending: &str,
    write_counter: &mut u64,
) {
    let count_result: redis::RedisResult<i64> = redis.llen(key_pending).await;
    let count = match count_result {
        Ok(n) => n,
        Err(e) => { warn!("Redis LLEN failed: {e}"); return; }
    };
    if count == 0 { return; }

    let items_result: redis::RedisResult<Vec<String>> =
        redis.lrange(key_pending, 0, (count - 1) as isize).await;
    let items = match items_result {
        Ok(v) => v,
        Err(e) => { warn!("Redis LRANGE failed: {e}"); return; }
    };

    struct MetricRow {
        pool_name: String,
        read_bw_mb: f64,
        write_bw_mb: f64,
        iops: f64,
        alloc_gb: f64,
        free_gb: f64,
        cpu_percent: f64,
        arc_hit_ratio: f64,
    }

    // Group by pool_name and average the values in the 5-minute block
    // Sum tuple: (read_bw, write_bw, iops, alloc, free, cpu, arc_hit, sample_count)
    type PoolSums = (f64, f64, f64, f64, f64, f64, f64, usize);
    let mut pool_sums: std::collections::HashMap<String, PoolSums> = std::collections::HashMap::new();
    for item in &items {
        let v: serde_json::Value = match serde_json::from_str(item) {
            Ok(val) => val,
            Err(e)  => { warn!("Failed to parse metric JSON: {e}"); continue; }
        };
        let pool_name = v["pool_name"].as_str().unwrap_or("").to_string();
        let read_bw   = v["read_bw_mb"].as_f64().unwrap_or(0.0);
        let write_bw  = v["write_bw_mb"].as_f64().unwrap_or(0.0);
        let iops      = v["iops"].as_f64().unwrap_or(0.0);
        let alloc     = v["alloc_gb"].as_f64().unwrap_or(0.0);
        let free      = v["free_gb"].as_f64().unwrap_or(0.0);
        let cpu       = v["cpu_percent"].as_f64().unwrap_or(0.0);
        let arc       = v["arc_hit_ratio"].as_f64().unwrap_or(0.0);

        let entry = pool_sums.entry(pool_name).or_insert((0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0));
        entry.0 += read_bw;
        entry.1 += write_bw;
        entry.2 += iops;
        entry.3 = alloc; // Keep the latest capacity alloc_gb
        entry.4 = free;  // Keep the latest capacity free_gb
        entry.5 += cpu;
        entry.6 += arc;
        entry.7 += 1;
    }

    let mut rows: Vec<MetricRow> = Vec::with_capacity(pool_sums.len());
    for (pool_name, (read_bw, write_bw, iops, alloc, free, cpu, arc, count)) in pool_sums {
        if count == 0 { continue; }
        let divisor = count as f64;
        rows.push(MetricRow {
            pool_name,
            read_bw_mb:    read_bw / divisor,
            write_bw_mb:   write_bw / divisor,
            iops:          iops / divisor,
            alloc_gb:      alloc,
            free_gb:       free,
            cpu_percent:   cpu / divisor,
            arc_hit_ratio: arc / divisor,
        });
    }

    if rows.is_empty() { return; }

    let mut param_idx = 1usize;
    let mut placeholders: Vec<String> = Vec::with_capacity(rows.len());
    for _ in &rows {
        placeholders.push(format!(
            "(${}, ${}, ${}, ${}, ${}, ${}, ${}, ${})",
            param_idx, param_idx+1, param_idx+2, param_idx+3,
            param_idx+4, param_idx+5, param_idx+6, param_idx+7
        ));
        param_idx += 8;
    }

    let sql = format!(
        "INSERT INTO zfs_metrics \
         (pool_name, read_bw_mb, write_bw_mb, iops, alloc_gb, free_gb, cpu_percent, arc_hit_ratio) \
         VALUES {}",
        placeholders.join(", ")
    );

    let mut params: Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>> =
        Vec::with_capacity(rows.len() * 8);
    for r in &rows {
        params.push(Box::new(r.pool_name.clone()));
        params.push(Box::new(r.read_bw_mb));
        params.push(Box::new(r.write_bw_mb));
        params.push(Box::new(r.iops));
        params.push(Box::new(r.alloc_gb));
        params.push(Box::new(r.free_gb));
        params.push(Box::new(r.cpu_percent));
        params.push(Box::new(r.arc_hit_ratio));
    }

    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        params.iter().map(|b| b.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync)).collect();

    match pg.execute(sql.as_str(), param_refs.as_slice()).await {
        Ok(n) => {
            *write_counter += n;
            info!("Batch-inserted {n} metric rows (total writes: {})", write_counter);
        }
        Err(e) => warn!("Batch INSERT into zfs_metrics failed: {e}"),
    }

    let ltrim_result: redis::RedisResult<()> = redis.ltrim(key_pending, count as isize, -1).await;
    if let Err(e) = ltrim_result {
        warn!("Redis LTRIM after sync failed: {e}");
    }
}

async fn enforce_retention(pg: &tokio_postgres::Client) {
    match pg.execute(
        "DELETE FROM zfs_metrics WHERE collected_at < NOW() - INTERVAL '30 days'",
        &[],
    ).await {
        Ok(deleted) if deleted > 0 => info!("Retention: removed {deleted} expired metric rows"),
        Ok(_) => {}
        Err(e) => warn!("Retention DELETE failed: {e}"),
    }

    match pg.query_one("SELECT COUNT(*) FROM zfs_metrics", &[]).await {
        Ok(row) => {
            let count: i64 = row.get(0);
            if count > 500_000 {
                warn!("zfs_metrics table has {count} rows — consider shortening retention or the collection interval");
            }
        }
        Err(e) => warn!("Failed to check zfs_metrics row count: {e}"),
    }
}

/// Fast 1s loop — no iostat syscall.
///
/// Reads CPU% and ARC from /proc, reads cached IO snapshot from AppState,
/// then writes a combined payload to `zfs:live:snapshot` in Redis.
async fn run_live_loop(state: crate::state::AppState) {
    let mut ticker = interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut t1 = read_cpu_jiffies();

    loop {
        ticker.tick().await;

        let t2 = read_cpu_jiffies();
        let cpu_percent = if t2.0 > t1.0 {
            let dt = (t2.0 - t1.0) as f64;
            let di = t2.1.saturating_sub(t1.1) as f64;
            ((dt - di) / dt * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        t1 = t2;

        let arc_hit_ratio = read_arc_hit_ratio();

        // Read cached iostat values — zero-cost, no syscall.
        let (read_bw_mb, write_bw_mb, read_iops, write_iops) = {
            let cache = state.io_cache.read().await;
            (cache.read_bw_mb, cache.write_bw_mb, cache.read_iops, cache.write_iops)
        };

        let total_read_bytes  = state.total_read_bytes.load(Ordering::Relaxed);
        let total_write_bytes = state.total_write_bytes.load(Ordering::Relaxed);
        let total_read_mb  = total_read_bytes  as f64 / 1_048_576.0;
        let total_write_mb = total_write_bytes as f64 / 1_048_576.0;

        let payload = serde_json::json!({
            "cpu_percent":    cpu_percent,
            "arc_hit_ratio":  arc_hit_ratio,
            "total_read_mb":  total_read_mb,
            "total_write_mb": total_write_mb,
            "read_bw_mb":     read_bw_mb,
            "write_bw_mb":    write_bw_mb,
            "read_iops":      read_iops,
            "write_iops":     write_iops,
        });

        if let Some(ref redis_conn) = state.redis {
            let mut conn = redis_conn.clone();
            if let Ok(json_str) = serde_json::to_string(&payload) {
                let _: redis::RedisResult<()> =
                    conn.set_ex("zfs:live:snapshot", json_str, 5u64).await;
            }
        }
    }
}

/// Slow 1s loop — does the actual `zpool iostat -v` syscall.
///
/// Cadence breakdown:
///   - Every tick (1 s): iostat syscall, update in-memory cache, accumulate byte totals,
///     push to Redis pending + per-disk key, update zfs:metrics:latest for charts.
///   - Every 6th tick (~6 s): batch-sync Redis pending → PostgreSQL.
///   - Every 60 s: persist cumulative totals to global_stats.
///   - Every 3600 s: prune old rows, check table size.
async fn run_slow_loop(state: crate::state::AppState) {
    const KEY_PENDING: &str = "zfs:metrics:pending";
    const KEY_LATEST:  &str = "zfs:metrics:latest";
    const TOTALS_INTERVAL:    Duration = Duration::from_secs(60);
    const RETENTION_INTERVAL: Duration = Duration::from_secs(3600);
    // Each iostat call measures 1 s of bandwidth; the loop runs every 1 s.
    const TICK_SECS: f64 = 1.0;

    let mut ticker = interval(Duration::from_secs(1));
    // If the iostat call overruns 1 s, wait for the full interval rather than bursting.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut pg_tick: u32 = 0;
    let mut prev_tr: u64 = 0;
    let mut prev_tw: u64 = 0;
    let mut last_totals_write = Instant::now() - TOTALS_INTERVAL;
    let mut write_counter: u64 = 0;
    let mut last_retention = Instant::now() - RETENTION_INTERVAL;

    loop {
        ticker.tick().await;
        pg_tick = pg_tick.wrapping_add(1);
        let do_pg_sync = pg_tick >= 300; // 300 seconds = 5 minutes
        if do_pg_sync { pg_tick = 0; }

        let pools = get_pool_names().await;
        let rewrite_deltas = crate::routes::datasets::pop_rewrite_deltas().await;

        // ── Collect metrics per pool ──────────────────────────────────────────
        let mut agg_read_bw_mb:  f64 = 0.0;
        let mut agg_write_bw_mb: f64 = 0.0;
        let mut agg_read_iops:   f64 = 0.0;
        let mut agg_write_iops:  f64 = 0.0;

        // cpu_percent / arc are read by the fast loop from /proc; the slow loop
        // also needs them to store in the metrics DB row.
        let t_now = read_cpu_jiffies();
        let arc_now = read_arc_hit_ratio();
        // We don't maintain a delta here — the fast loop owns that.
        // For DB storage a 0 is acceptable; the dashboard reads cpu from live snapshot.
        let cpu_for_db = 0.0f64;
        let _ = t_now; // suppress unused warning

        let mut pool_entries: Vec<serde_json::Value> = Vec::new();
        let mut new_pool_disks: std::collections::HashMap<String, Vec<DiskMetric>> =
            std::collections::HashMap::new();

        if pools.is_empty() {
            pool_entries.push(serde_json::json!({
                "pool_name":    "",
                "read_bw_mb":   0.0,
                "write_bw_mb":  0.0,
                "iops":         0.0,
                "alloc_gb":     0.0,
                "free_gb":      0.0,
                "cpu_percent":  cpu_for_db,
                "arc_hit_ratio":arc_now,
            }));
        } else {
            for pool in &pools {
                let res = match get_pool_iostat_with_disks(pool).await {
                    Some(r) => r,
                    None    => continue,
                };

                let scrub_bps = get_scrub_speed_bps(pool).await;
                let rewrite_delta = rewrite_deltas.get(pool).copied().unwrap_or(0);

                let net_read_bw_bytes = (res.read_bw_bytes - scrub_bps as f64 - rewrite_delta as f64).max(0.0);
                let net_write_bw_bytes = (res.write_bw_bytes - rewrite_delta as f64).max(0.0);

                // Accumulate all-time byte totals (bytes/sec × 1 s = bytes) - excluding scrub & rewrite
                state.total_read_bytes .fetch_add((net_read_bw_bytes  * TICK_SECS) as u64, Ordering::Relaxed);
                state.total_write_bytes.fetch_add((net_write_bw_bytes * TICK_SECS) as u64, Ordering::Relaxed);

                // Keep real physical metrics in the charts/live dashboard displays
                agg_read_bw_mb  += res.read_bw_mb;
                agg_write_bw_mb += res.write_bw_mb;
                agg_read_iops   += res.read_iops;
                agg_write_iops  += res.write_iops;

                // Use RAID-aware alloc/free from zpool list for accurate capacity.
                let (cap_alloc_gb, cap_free_gb) = get_pool_capacity(pool).await
                    .unwrap_or((res.alloc_gb, res.free_gb));

                pool_entries.push(serde_json::json!({
                    "pool_name":     pool,
                    "read_bw_mb":    res.read_bw_mb,
                    "write_bw_mb":   res.write_bw_mb,
                    "iops":          res.iops,
                    "alloc_gb":      cap_alloc_gb,
                    "free_gb":       cap_free_gb,
                    "cpu_percent":   cpu_for_db,
                    "arc_hit_ratio": arc_now,
                }));

                // Accumulate per-disk 1-second I/O deltas → running total for the UI.
                let updated_disks: Vec<DiskMetric> = if res.disks.is_empty() {
                    vec![]
                } else {
                    let mut acc = state.disk_cumulative.write().await;
                    let pool_acc = acc.entry(pool.clone()).or_default();
                    res.disks.iter().map(|d| {
                        let entry = pool_acc.entry(d.name.clone()).or_insert((0u64, 0u64));
                        entry.0 = entry.0.saturating_add((d.read_bw_mb  * 1_048_576.0) as u64);
                        entry.1 = entry.1.saturating_add((d.write_bw_mb * 1_048_576.0) as u64);
                        DiskMetric {
                            name:           d.name.clone(),
                            read_bw_mb:     d.read_bw_mb,
                            write_bw_mb:    d.write_bw_mb,
                            read_iops:      d.read_iops,
                            write_iops:     d.write_iops,
                            total_read_gb:  entry.0 as f64 / 1_073_741_824.0,
                            total_write_gb: entry.1 as f64 / 1_073_741_824.0,
                        }
                    }).collect()
                };

                // Per-disk data for Redis + API
                if !updated_disks.is_empty() {
                    new_pool_disks.insert(pool.clone(), updated_disks.clone());

                    if let Some(ref redis_conn) = state.redis {
                        let mut conn = redis_conn.clone();
                        let disk_json: Vec<serde_json::Value> = updated_disks.iter().map(|d| {
                            serde_json::json!({
                                "name":           d.name,
                                "read_bw_mb":     d.read_bw_mb,
                                "write_bw_mb":    d.write_bw_mb,
                                "read_iops":      d.read_iops,
                                "write_iops":     d.write_iops,
                                "total_read_gb":  d.total_read_gb,
                                "total_write_gb": d.total_write_gb,
                            })
                        }).collect();
                        let redis_key = format!("zfs:disks:{}:latest", pool);
                        if let Ok(s) = serde_json::to_string(&disk_json) {
                            let _: redis::RedisResult<()> = conn.set_ex(&redis_key, s, 10u64).await;
                        }
                    }
                }
            }
        }

        // ── Update in-memory cache (read by fast loop, no syscall) ────────────
        {
            let mut cache = state.io_cache.write().await;
            cache.read_bw_mb  = agg_read_bw_mb;
            cache.write_bw_mb = agg_write_bw_mb;
            cache.read_iops   = agg_read_iops;
            cache.write_iops  = agg_write_iops;
            cache.pool_disks  = new_pool_disks;
        }

        // ── Redis: push pending metrics + update latest key ───────────────────
        if let Some(ref redis_conn) = state.redis {
            let mut conn = redis_conn.clone();
            for entry in &pool_entries {
                if let Ok(payload) = serde_json::to_string(entry) {
                    push_to_redis(&mut conn, KEY_PENDING, KEY_LATEST, &payload).await;
                }
            }
            if do_pg_sync {
                if let Some(ref pg_client) = state.pg {
                    sync_redis_to_postgres(&mut conn, pg_client, KEY_PENDING, &mut write_counter).await;
                }
            }
        } else if do_pg_sync {
            // No Redis — direct batch insert every 6th tick (~6 s)
            if let Some(ref pg_client) = state.pg {
                struct DirectRow {
                    pool_name: String, read_bw_mb: f64, write_bw_mb: f64,
                    iops: f64, alloc_gb: f64, free_gb: f64, cpu_v: f64, arc_v: f64,
                }
                let rows: Vec<DirectRow> = pool_entries.iter().map(|e| DirectRow {
                    pool_name:   e["pool_name"].as_str().unwrap_or("").to_string(),
                    read_bw_mb:  e["read_bw_mb"].as_f64().unwrap_or(0.0),
                    write_bw_mb: e["write_bw_mb"].as_f64().unwrap_or(0.0),
                    iops:        e["iops"].as_f64().unwrap_or(0.0),
                    alloc_gb:    e["alloc_gb"].as_f64().unwrap_or(0.0),
                    free_gb:     e["free_gb"].as_f64().unwrap_or(0.0),
                    cpu_v:       e["cpu_percent"].as_f64().unwrap_or(0.0),
                    arc_v:       e["arc_hit_ratio"].as_f64().unwrap_or(0.0),
                }).collect();

                if !rows.is_empty() {
                    let mut idx = 1usize;
                    let mut placeholders: Vec<String> = Vec::with_capacity(rows.len());
                    for _ in &rows {
                        placeholders.push(format!(
                            "(${}, ${}, ${}, ${}, ${}, ${}, ${}, ${})",
                            idx, idx+1, idx+2, idx+3, idx+4, idx+5, idx+6, idx+7
                        ));
                        idx += 8;
                    }
                    let sql = format!(
                        "INSERT INTO zfs_metrics \
                         (pool_name, read_bw_mb, write_bw_mb, iops, alloc_gb, free_gb, cpu_percent, arc_hit_ratio) \
                         VALUES {}", placeholders.join(", ")
                    );
                    let mut params: Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>> =
                        Vec::with_capacity(rows.len() * 8);
                    for r in &rows {
                        params.push(Box::new(r.pool_name.clone()));
                        params.push(Box::new(r.read_bw_mb));
                        params.push(Box::new(r.write_bw_mb));
                        params.push(Box::new(r.iops));
                        params.push(Box::new(r.alloc_gb));
                        params.push(Box::new(r.free_gb));
                        params.push(Box::new(r.cpu_v));
                        params.push(Box::new(r.arc_v));
                    }
                    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
                        params.iter().map(|b| b.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
                    match pg_client.execute(sql.as_str(), param_refs.as_slice()).await {
                        Ok(n) => {
                            write_counter += n;
                            info!("Direct batch-inserted {n} metric rows (total writes: {write_counter})");
                        }
                        Err(e) => warn!("Direct batch INSERT failed: {e}"),
                    }
                }
            }
        }

        // ── Persist cumulative totals every 15 s ─────────────────────────────
        let tr = state.total_read_bytes .load(Ordering::Relaxed);
        let tw = state.total_write_bytes.load(Ordering::Relaxed);
        let totals_due     = last_totals_write.elapsed() >= TOTALS_INTERVAL;
        let totals_changed = tr != prev_tr || tw != prev_tw;
        if totals_due && totals_changed {
            let db_backend = std::env::var("DB_BACKEND").unwrap_or_else(|_| "postgres".to_string());
            if db_backend == "redis" {
                if let Some(ref redis_conn) = state.redis {
                    let mut conn = redis_conn.clone();
                    let _: redis::RedisResult<()> = conn.set("zfs:totals:read_bytes",  tr.to_string()).await;
                    let _: redis::RedisResult<()> = conn.set("zfs:totals:write_bytes", tw.to_string()).await;
                }
            } else if let Some(ref pg_client) = state.pg {
                let tr_i = tr as i64;
                let tw_i = tw as i64;
                match pg_client.execute(
                    "UPDATE global_stats SET total_read_bytes = $1, total_write_bytes = $2 WHERE id = 1",
                    &[&tr_i, &tw_i],
                ).await {
                    Ok(_) => info!("Persisted cumulative totals (read={tr}, write={tw})"),
                    Err(e) => warn!("Failed to update global_stats: {e}"),
                }

                // Persist per-disk cumulative totals so they survive restarts.
                let disk_snap: Vec<(String, String, i64, i64)> = {
                    let acc = state.disk_cumulative.read().await;
                    acc.iter().flat_map(|(pool, disks)| {
                        disks.iter().map(move |(disk, (r, w))| {
                            (pool.clone(), disk.clone(), *r as i64, *w as i64)
                        })
                    }).collect()
                };
                for (pool, disk, r, w) in disk_snap {
                    let _ = pg_client.execute(
                        "INSERT INTO disk_stats (pool_name, disk_name, total_read_bytes, total_write_bytes) \
                         VALUES ($1, $2, $3, $4) \
                         ON CONFLICT (pool_name, disk_name) DO UPDATE \
                         SET total_read_bytes = EXCLUDED.total_read_bytes, \
                             total_write_bytes = EXCLUDED.total_write_bytes",
                        &[&pool, &disk, &r, &w],
                    ).await;
                }
            }
            prev_tr = tr;
            prev_tw = tw;
            last_totals_write = Instant::now();
        }

        // ── Hourly retention ─────────────────────────────────────────────────
        if last_retention.elapsed() >= RETENTION_INTERVAL {
            if let Some(ref pg_client) = state.pg {
                enforce_retention(pg_client).await;
            }
            last_retention = Instant::now();
        }

    }
}

async fn run_notifications_loop(state: crate::state::AppState) {
    let mut ticker = interval(Duration::from_secs(60));
    loop {
        ticker.tick().await;
        check_and_trigger_notifications(&state).await;
    }
}

/// Periodically evaluates scrub schedules and triggers zpool scrub if needed.
async fn run_scrub_scheduler_loop() {
    let mut ticker = interval(Duration::from_secs(60));
    loop {
        ticker.tick().await;
        // Evaluate the cron schedule in the host's LOCAL timezone so presets
        // like "Every Day @ 00:00" fire at local midnight, not UTC midnight.
        let now = Local::now();
        let pools = get_pool_names().await;
        
        for pool in pools {
            let output = tokio::process::Command::new("zfs")
                .args(["get", "-H", "-o", "value", "zfsmanager:scrub_schedule", &pool])
                .output()
                .await;
                
            let mut schedule_val = match output {
                Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
                _ => continue,
            };

            if schedule_val.is_empty() || schedule_val == "-" {
                schedule_val = r#"{"enabled":true,"type":"monthly","cron":"0 0 0 1 * * *"}"#.to_string();
            } else if schedule_val == "off" {
                continue;
            }

            let parsed: Result<serde_json::Value, _> = serde_json::from_str(&schedule_val);
            if let Ok(json) = parsed {
                if let Some(true) = json.get("enabled").and_then(|v| v.as_bool()) {
                    if let Some(cron_str) = json.get("cron").and_then(|v| v.as_str()) {
                        if let Ok(schedule) = Schedule::from_str(cron_str) {
                            let one_min_ago = now - chrono::Duration::minutes(1);
                            if let Some(next_run) = schedule.after(&one_min_ago).next() {
                                let diff = now.signed_duration_since(next_run).num_seconds();
                                if (0..60).contains(&diff) {
                                    info!("Triggering scheduled scrub for pool: {}", pool);
                                    let _ = tokio::process::Command::new("zpool")
                                        .args(["scrub", &pool])
                                        .output()
                                        .await;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

async fn run_cache_warming_loop(state: crate::state::AppState) {
    let mut ticker = interval(Duration::from_secs(30));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        refresh_metrics_history_caches(&state).await;
    }
}

pub async fn run_metrics_worker(state: crate::state::AppState) {
    let state_live   = state.clone();
    let state_slow   = state.clone();
    let state_notify = state.clone();
    let state_warm   = state;

    tokio::join!(
        run_live_loop(state_live),
        run_slow_loop(state_slow),
        run_notifications_loop(state_notify),
        run_cache_warming_loop(state_warm),
        run_scrub_scheduler_loop(),
    );
}

// Startup: warm Redis from PostgreSQL before worker loops
//
// Seeds the three Redis keys that the frontend reads on first page load so that
// the UI shows correct data immediately rather than waiting for the first 1s tick.
pub async fn warm_redis_from_postgres(state: &crate::state::AppState) {
    let redis = match &state.redis {
        Some(r) => r,
        None => return,
    };
    let pg = match &state.pg {
        Some(p) => p,
        None => return,
    };
    let mut conn = redis.clone();

    // 1. Seed zfs:live:snapshot with persisted totals so the all-time counters
    //    are correct on first API call, before the 1s live loop fires.
    {
        use std::sync::atomic::Ordering;
        let total_read_mb  = state.total_read_bytes.load(Ordering::Relaxed)  as f64 / 1_048_576.0;
        let total_write_mb = state.total_write_bytes.load(Ordering::Relaxed) as f64 / 1_048_576.0;
        let payload = serde_json::json!({
            "cpu_percent":    0.0,
            "arc_hit_ratio":  0.0,
            "total_read_mb":  total_read_mb,
            "total_write_mb": total_write_mb,
            "read_bw_mb":     0.0,
            "write_bw_mb":    0.0,
            "read_iops":      0.0,
            "write_iops":     0.0,
        });
        if let Ok(json_str) = serde_json::to_string(&payload) {
            let _: redis::RedisResult<()> = conn.set_ex("zfs:live:snapshot", json_str, 30u64).await;
        }
    }

    // 2. Seed zfs:metrics:latest from the most recent PostgreSQL row so that
    //    the chart has a data point immediately (before the first slow-loop tick).
    if let Ok(row) = pg.query_one(
        "SELECT pool_name, read_bw_mb, write_bw_mb, iops, alloc_gb, free_gb, \
         cpu_percent, arc_hit_ratio \
         FROM zfs_metrics ORDER BY collected_at DESC LIMIT 1",
        &[],
    ).await {
        let payload = serde_json::json!({
            "pool_name":     row.get::<_, String>(0),
            "read_bw_mb":    row.get::<_, f64>(1),
            "write_bw_mb":   row.get::<_, f64>(2),
            "iops":          row.get::<_, f64>(3),
            "alloc_gb":      row.get::<_, f64>(4),
            "free_gb":       row.get::<_, f64>(5),
            "cpu_percent":   row.get::<_, f64>(6),
            "arc_hit_ratio": row.get::<_, f64>(7),
        });
        if let Ok(json_str) = serde_json::to_string(&payload) {
            let _: redis::RedisResult<()> =
                conn.set_ex("zfs:metrics:latest", json_str, 30u64).await;
        }
        info!("Startup: seeded zfs:metrics:latest from PostgreSQL");
    }

    // 3. Seed per-disk Redis keys AND in-memory io_cache.pool_disks from persisted
    //    cumulative totals so the Physical Disks table shows correct all-time values
    //    immediately — both the Redis path and the in-memory fallback path are populated.
    {
        let acc = state.disk_cumulative.read().await;
        let mut cache_pool_disks: std::collections::HashMap<String, Vec<crate::state::DiskMetric>> =
            std::collections::HashMap::new();

        for (pool, disks) in acc.iter() {
            let metrics: Vec<crate::state::DiskMetric> = disks.iter().map(|(name, (r, w))| {
                crate::state::DiskMetric {
                    name:           name.clone(),
                    read_bw_mb:     0.0,
                    write_bw_mb:    0.0,
                    read_iops:      0.0,
                    write_iops:     0.0,
                    total_read_gb:  *r as f64 / 1_073_741_824.0,
                    total_write_gb: *w as f64 / 1_073_741_824.0,
                }
            }).collect();

            // Redis seed
            let disk_list: Vec<serde_json::Value> = metrics.iter().map(|m| serde_json::json!({
                "name":           m.name,
                "read_bw_mb":     0.0,
                "write_bw_mb":    0.0,
                "read_iops":      0.0,
                "write_iops":     0.0,
                "total_read_gb":  m.total_read_gb,
                "total_write_gb": m.total_write_gb,
            })).collect();
            if let Ok(json_str) = serde_json::to_string(&disk_list) {
                let key = format!("zfs:disks:{}:latest", pool);
                let _: redis::RedisResult<()> = conn.set_ex(&key, json_str, 30u64).await;
            }

            cache_pool_disks.insert(pool.clone(), metrics);
        }

        let n: usize = acc.values().map(|m| m.len()).sum();
        drop(acc);

        // Seed the in-memory io_cache so the fallback API path also returns non-zero totals.
        if !cache_pool_disks.is_empty() {
            let mut cache = state.io_cache.write().await;
            cache.pool_disks = cache_pool_disks;
        }

        if n > 0 {
            info!("Startup: seeded Redis + io_cache per-disk keys ({n} disks across several pools)");
        }
    }
}

// Startup: warm Redis list caches from ZFS commands so the first web request is instant.
//
// Runs zpool/zfs list in parallel and seeds zfs:pools, zfs:datasets,
// zfs:snapshots, zfs:volumes with a 60s TTL. Also pre-warms the two most-used
// metrics history intervals (1h, 1d) from PostgreSQL so the Performance tab
// loads instantly on first visit.
pub async fn warm_list_caches(state: &crate::state::AppState) {
    let redis = match &state.redis {
        Some(r) => r,
        None => return,
    };
    let mut conn = redis.clone();

    // Run all four ZFS list commands in parallel
    let (pools_out, datasets_out, snaps_out, vols_out) = tokio::join!(
        tokio::process::Command::new("zpool")
            .args(["list", "-H", "-p", "-o", "name,size,alloc,free,frag,cap,dedup,health,altroot"])
            .output(),
        tokio::process::Command::new("zfs")
            .args(["list", "-H", "-p", "-t", "filesystem",
                   "-o", "name,used,avail,refer,mountpoint,compression,dedup,readonly"])
            .output(),
        tokio::process::Command::new("zfs")
            .args(["list", "-H", "-p", "-t", "snapshot",
                   "-o", "name,used,refer,creation"])
            .output(),
        tokio::process::Command::new("zfs")
            .args(["list", "-H", "-p", "-t", "volume",
                   "-o", "name,used,avail,refer,volsize"])
            .output(),
    );

    if let Ok(out) = pools_out {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);

            // Also fetch available/used from zfs get for the pools
            let avail_raw = crate::executor::zfs(&["get", "-H", "-p", "-o", "name,value", "available"])
                .await.unwrap_or_default();
            let used_raw  = crate::executor::zfs(&["get", "-H", "-p", "-o", "name,value", "used"])
                .await.unwrap_or_default();

            let avail_map: std::collections::HashMap<&str, u64> = avail_raw.lines()
                .filter_map(|l| { let mut p = l.splitn(2, '\t'); Some((p.next()?, p.next()?.trim().parse().ok()?)) })
                .collect();
            let used_map: std::collections::HashMap<&str, u64> = used_raw.lines()
                .filter_map(|l| { let mut p = l.splitn(2, '\t'); Some((p.next()?, p.next()?.trim().parse().ok()?)) })
                .collect();

            let pools: Vec<serde_json::Value> = raw.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|line| {
                    let c: Vec<&str> = line.split('\t').collect();
                    let name = c.first().copied().unwrap_or("");
                    serde_json::json!({
                        "name": name, "size": c.get(1).unwrap_or(&""),
                        "alloc": c.get(2).unwrap_or(&""), "free": c.get(3).unwrap_or(&""),
                        "frag": c.get(4).unwrap_or(&""), "cap": c.get(5).unwrap_or(&""),
                        "dedup": c.get(6).unwrap_or(&""), "health": c.get(7).unwrap_or(&""),
                        "altroot": c.get(8).unwrap_or(&""),
                        "available_bytes": avail_map.get(name).copied().unwrap_or(0),
                        "used_bytes": used_map.get(name).copied().unwrap_or(0),
                    })
                })
                .collect();
            let payload = serde_json::json!({ "pools": pools });
            if let Ok(s) = serde_json::to_string(&payload) {
                let _: redis::RedisResult<()> = conn.set_ex("zfs:pools", s, 60u64).await;
                info!("Startup: seeded zfs:pools ({} pools)", pools.len());
            }
        }
    }

    if let Ok(out) = datasets_out {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let datasets: Vec<serde_json::Value> = raw.lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|line| {
                    let c: Vec<&str> = line.split('\t').collect();
                    let name = c.first().unwrap_or(&"");
                    if name.contains("/.system") || name.contains("/ix-apps") { return None; }
                    Some(serde_json::json!({
                        "name": name, "used": c.get(1).unwrap_or(&""),
                        "available": c.get(2).unwrap_or(&""), "refer": c.get(3).unwrap_or(&""),
                        "mountpoint": c.get(4).unwrap_or(&""),
                        "compression": c.get(5).unwrap_or(&"off"),
                        "dedup": c.get(6).unwrap_or(&"off"),
                        "readonly": c.get(7).unwrap_or(&"off"),
                    }))
                })
                .collect();
            let payload = serde_json::json!({ "datasets": datasets });
            if let Ok(s) = serde_json::to_string(&payload) {
                let _: redis::RedisResult<()> = conn.set_ex("zfs:datasets", s, 60u64).await;
                info!("Startup: seeded zfs:datasets ({} datasets)", datasets.len());
            }
        }
    }

    if let Ok(out) = snaps_out {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let snaps: Vec<serde_json::Value> = raw.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|line| {
                    let c: Vec<&str> = line.split('\t').collect();
                    serde_json::json!({
                        "name": c.first().unwrap_or(&""), "used": c.get(1).unwrap_or(&""),
                        "refer": c.get(2).unwrap_or(&""), "creation": c.get(3).unwrap_or(&""),
                    })
                })
                .collect();
            let payload = serde_json::json!({ "snapshots": snaps });
            if let Ok(s) = serde_json::to_string(&payload) {
                let _: redis::RedisResult<()> = conn.set_ex("zfs:snapshots", s, 60u64).await;
                info!("Startup: seeded zfs:snapshots ({} snapshots)", snaps.len());
            }
        }
    }

    if let Ok(out) = vols_out {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let vols: Vec<serde_json::Value> = raw.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|line| {
                    let c: Vec<&str> = line.split('\t').collect();
                    serde_json::json!({
                        "name": c.first().unwrap_or(&""), "used": c.get(1).unwrap_or(&""),
                        "avail": c.get(2).unwrap_or(&""), "refer": c.get(3).unwrap_or(&""),
                        "volsize": c.get(4).unwrap_or(&""),
                    })
                })
                .collect();
            let payload = serde_json::json!({ "volumes": vols });
            if let Ok(s) = serde_json::to_string(&payload) {
                let _: redis::RedisResult<()> = conn.set_ex("zfs:volumes", s, 60u64).await;
                info!("Startup: seeded zfs:volumes ({} volumes)", vols.len());
            }
        }
    }

    // Pre-warm metrics history & fill prediction caches in Redis
    // so the Performance tab and Dashboard load instantly.
    refresh_metrics_history_caches(state).await;
}

async fn get_scrub_speed_bps(pool: &str) -> u64 {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::process::Command::new("zpool")
            .args(["status", pool])
            .output()
    ).await;
    let out = match output {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return 0,
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    
    let lines: Vec<&str> = stdout.lines().collect();
    let mut scan_detail = String::new();
    let mut in_scan = false;
    for line in lines {
        if line.trim_start().starts_with("scan:") {
            scan_detail.push_str(line.trim());
            in_scan = true;
        } else if in_scan && (line.starts_with('\t') || line.starts_with("  ")) {
            if !scan_detail.is_empty() { scan_detail.push(' '); }
            scan_detail.push_str(line.trim());
        } else if in_scan {
            break;
        }
    }
    
    if scan_detail.is_empty() { return 0; }
    
    if !scan_detail.contains("in progress") { return 0; }
    
    let speed_str = if scan_detail.contains("resilver in progress") {
        scan_detail.split("issued at ").nth(1)
            .and_then(|s| s.split(',').next())
            .unwrap_or("").trim()
    } else {
        scan_detail.split(" at ").nth(1)
            .and_then(|s| s.split(',').next())
            .unwrap_or("").trim()
    };
    
    if speed_str.is_empty() { return 0; }
    
    let val_str = speed_str.trim_end_matches("/s").trim();
    if val_str.is_empty() { return 0; }
    
    let last = val_str.chars().last().unwrap_or('B');
    let num_part = if last.is_alphabetic() {
        &val_str[..val_str.len() - 1]
    } else {
        val_str
    };
    
    let num = num_part.parse::<f64>().unwrap_or(0.0);
    let mult = match last.to_ascii_uppercase() {
        'T' => 1_099_511_627_776.0,
        'G' => 1_073_741_824.0,
        'M' => 1_048_576.0,
        'K' => 1024.0,
        _ => 1.0,
    };
    
    (num * mult) as u64
}

pub async fn refresh_metrics_history_caches(state: &crate::state::AppState) {
    let pg = match &state.pg {
        Some(pg) => pg,
        None => return,
    };
    let redis_conn = match &state.redis {
        Some(conn) => conn,
        None => return,
    };
    let mut conn = redis_conn.clone();

    let intervals = &["1h", "6h", "1d", "1w", "1m", "1y"];

    for interval in intervals {
        let query = crate::routes::metrics::build_query(interval);
        let ttl = crate::routes::metrics::cache_ttl(interval);

        match pg.query(&query, &[]).await {
            Ok(rows) => {
                let metrics: Vec<serde_json::Value> = rows.iter().map(|row| {
                    let collected_at: chrono::DateTime<chrono::Utc> = row.get(0);
                    serde_json::json!({
                        "collected_at":  collected_at.to_rfc3339(),
                        "pool_name":     row.get::<_, String>(1),
                        "read_bw_mb":    row.get::<_, f64>(2),
                        "write_bw_mb":   row.get::<_, f64>(3),
                        "iops":          row.get::<_, f64>(4),
                        "alloc_gb":      row.get::<_, f64>(5),
                        "free_gb":       row.get::<_, f64>(6),
                        "cpu_percent":   row.get::<_, f64>(7),
                        "arc_hit_ratio": row.get::<_, f64>(8),
                    })
                }).collect();
                let count = metrics.len();
                let payload = serde_json::json!({ "metrics": metrics, "interval": interval, "count": count });
                let cache_key = format!("zfs:history:{interval}");
                if let Ok(s) = serde_json::to_string(&payload) {
                    let _: redis::RedisResult<()> = conn.set_ex(&cache_key, s, ttl).await;
                }
            }
            Err(e) => warn!("Background: failed to refresh zfs:history:{interval}: {e}"),
        }
    }

    // Refresh fill prediction caches in Redis with a single consolidated query
    crate::routes::metrics::prewarm_all_fill_predictions(state).await;
}
