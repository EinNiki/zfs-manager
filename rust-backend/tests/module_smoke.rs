use std::collections::HashMap;

use zfs_dashboard::modules::runtime::{ModuleCtx, ModuleRuntime, RunLimits};

const IMMICH_WASM: &str =
    "../modules/immich/target/wasm32-wasip2/release/zfs_dashboard_module_immich.wasm";

fn load_immich_wasm() -> Option<Vec<u8>> {
    match std::fs::read(IMMICH_WASM) {
        Ok(bytes) => Some(bytes),
        Err(_) => {
            eprintln!("skipping: build the immich module first (cargo build --release --target wasm32-wasip2 in modules/immich)");
            None
        }
    }
}

fn ctx(secrets: HashMap<String, String>) -> ModuleCtx {
    ModuleCtx {
        module_id: "immich".into(),
        allowlist: Vec::new(),
        secrets,
        pg: None,
        config_json: r#"{"immich_url":"http://immich.invalid:2283","stats_to_fetch":["photos"]}"#.into(),
        internal_token: "test-token".into(),
    }
}

#[tokio::test]
async fn component_runs_and_reports_missing_secret() {
    let Some(wasm) = load_immich_wasm() else { return };
    let runtime = ModuleRuntime::new().expect("runtime");
    runtime.validate_component(&wasm).expect("valid component");

    let outcome = runtime.run(&wasm, ctx(HashMap::new()), &RunLimits::default()).await;
    assert!(!outcome.success);
    assert!(
        outcome.error.as_deref().unwrap_or("").contains("immich_api_key"),
        "expected missing-secret error, got: {:?}",
        outcome.error
    );
}

#[tokio::test]
async fn allowlist_blocks_unlisted_host_end_to_end() {
    let Some(wasm) = load_immich_wasm() else { return };
    let runtime = ModuleRuntime::new().expect("runtime");

    let mut secrets = HashMap::new();
    secrets.insert("immich_api_key".to_string(), "test-key".to_string());
    // Allowlist stays empty, so the configured immich host must be rejected
    // by the HOST before any connection attempt.
    let outcome = runtime.run(&wasm, ctx(secrets), &RunLimits::default()).await;
    assert!(!outcome.success);
    assert!(
        outcome.error.as_deref().unwrap_or("").contains("allowlist"),
        "expected allowlist rejection, got: {:?}",
        outcome.error
    );
}
