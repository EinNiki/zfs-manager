//! Proves the module sandbox blocks a deliberately hostile module.
//! Requires the malicious module to be built first:
//!   cd tests/malicious-module && cargo build --release --target wasm32-wasip2

use std::collections::HashMap;
use std::time::Duration;

use zfs_dashboard::modules::runtime::{ModuleCtx, ModuleRuntime, RunLimits};

const MALICIOUS_WASM: &str =
    "tests/malicious-module/target/wasm32-wasip2/release/malicious_module.wasm";

fn wasm() -> Option<Vec<u8>> {
    std::fs::read(MALICIOUS_WASM).ok().or_else(|| {
        eprintln!("skipping: build tests/malicious-module for wasm32-wasip2 first");
        None
    })
}

fn ctx(attack: &str) -> ModuleCtx {
    ModuleCtx {
        module_id: "malicious".into(),
        // Empty allowlist: the SSRF target must be rejected by the host.
        allowlist: Vec::new(),
        secrets: HashMap::new(),
        pg: None,
        config_json: format!(r#"{{"attack":"{attack}"}}"#),
        internal_token: "test-token".into(),
    }
}

async fn run(attack: &str, limits: RunLimits) -> (bool, String, Option<String>) {
    let runtime = ModuleRuntime::new().expect("runtime");
    let bytes = wasm().unwrap();
    let outcome = runtime.run(&bytes, ctx(attack), &limits).await;
    (outcome.success, outcome.message, outcome.error)
}

#[tokio::test]
async fn ssrf_is_blocked() {
    if wasm().is_none() { return; }
    let (success, message, _) = run("ssrf", RunLimits::default()).await;
    assert!(success, "run should complete gracefully");
    assert!(message.contains("blocked"), "SSRF not blocked: {message}");
    assert!(!message.contains("ESCAPED"));
}

#[tokio::test]
async fn filesystem_access_is_blocked() {
    if wasm().is_none() { return; }
    let (_, message, _) = run("fs", RunLimits::default()).await;
    assert!(!message.contains("ESCAPED"), "filesystem escape: {message}");
}

#[tokio::test]
async fn infinite_loop_is_killed_by_fuel() {
    if wasm().is_none() { return; }
    let limits = RunLimits { fuel: 50_000_000, memory_bytes: 64 * 1024 * 1024, timeout: Duration::from_secs(30) };
    let (success, _, error) = run("cpu", limits).await;
    assert!(!success, "infinite loop must fail");
    let err = error.unwrap_or_default();
    assert!(err.contains("fuel") || err.contains("timeout"), "unexpected error: {err}");
}

#[tokio::test]
async fn memory_bomb_is_capped() {
    if wasm().is_none() { return; }
    // 32 MiB cap; the module allocates in 16 MiB chunks.
    let limits = RunLimits { fuel: 5_000_000_000, memory_bytes: 32 * 1024 * 1024, timeout: Duration::from_secs(30) };
    let (success, _, error) = run("memory", limits).await;
    assert!(!success, "memory bomb must fail");
    assert!(error.is_some());
}

#[tokio::test]
async fn wall_clock_timeout_trips() {
    if wasm().is_none() { return; }
    let limits = RunLimits { fuel: u64::MAX, memory_bytes: 64 * 1024 * 1024, timeout: Duration::from_secs(1) };
    let (success, _, error) = run("cpu", limits).await;
    assert!(!success, "run must fail on timeout");
    let err = error.unwrap_or_default();
    // With unlimited fuel, only the epoch/wall-clock deadline can stop it.
    assert!(err.contains("timeout"), "expected timeout, got: {err}");
}

#[tokio::test]
async fn invalid_metric_is_rejected() {
    if wasm().is_none() { return; }
    let (_, message, _) = run("metric_abuse", RunLimits::default()).await;
    assert!(!message.contains("ESCAPED"), "metric validation bypassed: {message}");
}
