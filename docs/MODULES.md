# Module System

ZFS Dashboard can be extended with **modules** — community-buildable extensions that fetch external data (e.g. from other self-hosted services) and write it into the dashboard as metrics. Think Home Assistant + HACS, but for storage infrastructure.

Modules are written in Rust, compiled to a **WebAssembly component**, and run **sandboxed** inside the backend. They are never native code, and the server never compiles module source — it only runs finished, checksum-verified `.wasm` artifacts downloaded from GitHub Releases.

---

## Default Registry

The module Store fetches its listings from a **registry** — an `index.json` file at a public URL. By default, ZFS Dashboard uses the built-in registry from this repo:

```
https://raw.githubusercontent.com/ZFS-Dashboard/ZFS-Dashboard/refs/heads/main/registry/index.json
```

To use a **custom registry** instead (e.g. your own `index.json` with private or community modules), set the `MODULE_REGISTRY_URL` environment variable on the backend container:

```env
MODULE_REGISTRY_URL=https://example.com/my-registry/index.json
```

This replaces the default registry — the Store will fetch from your URL instead. Users can still add additional registries via the Store UI at runtime (those are stored in the database and persisted across restarts).

| Variable | Default | Description |
|---|---|---|
| `MODULE_REGISTRY_URL` | *(built-in ZFS-Dashboard registry)* | URL to the `index.json` the Store uses as its default registry. |

---

## Table of Contents

- [How It Works](#how-it-works)
- [Default Registry](#default-registry)
- [Security Model](#security-model)
- [Module Lifecycle](#module-lifecycle)
- [Writing a Module from Scratch](#writing-a-module-from-scratch)
  - [1. Project setup](#1-project-setup)
  - [2. The WIT interface (host API contract)](#2-the-wit-interface-host-api-contract)
  - [3. Implementing `run`](#3-implementing-run)
  - [4. The manifest (`module.toml`)](#4-the-manifest-moduletoml)
  - [5. Building to `wasm32-wasip2`](#5-building-to-wasm32-wasip2)
- [Publishing](#publishing)
  - [Registry index format](#registry-index-format)
  - [Custom registries](#custom-registries)
  - [Sideload (local/dev)](#sideload-localdev)
- [Releases & GitHub Workflows](#releases--github-workflows)
  - [How downloads work](#how-downloads-work)
  - [Release workflow template](#release-workflow-template)
  - [Creating a new release](#creating-a-new-release)
  - [Updating the registry after a release](#updating-the-registry-after-a-release)
- [Resource Limits](#resource-limits)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)

---

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    ZFS Dashboard backend                  │
│                                                          │
│  ┌─────────────┐     ┌─────────────────────────────────┐ │
│  │  Scheduler   │────▶│  Module Runtime (wasmtime)      │ │
│  │  (30s tick)  │     │                                 │ │
│  └─────────────┘     │  ┌───────────────────────────┐  │ │
│                      │  │  .wasm component (sandbox) │  │ │
│  ┌─────────────┐     │  │                             │  │ │
│  │  Store UI    │     │  │  run(config_json) ─────────┼──┼─▶ host-api:
│  │  (registry)  │     │  │                             │  │    http-fetch
│  └─────────────┘     │  │  ◀──── get-secret(key) ◀────┼──┼─    db-write-metric
│                      │  │  ◀──── log(level, msg) ◀─────┼──┼     log
│                      │  └───────────────────────────┘  │ │
│                      └─────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

1. The **scheduler** polls every 30 seconds and triggers due module runs based on each module's schedule (interval or cron).
2. The **runtime** instantiates the `.wasm` component inside a wasmtime sandbox with fuel, memory, and wall-clock limits.
3. The module calls **host API functions** (`http-fetch`, `db-write-metric`, `get-secret`, `log`) provided by the backend.
4. Metrics are written to PostgreSQL and displayed as widgets on the dashboard.

---

## Security Model

Modules run as **untrusted code** in a WebAssembly sandbox. The host enforces:

- **No filesystem access** — WASI is initialized with no preopened directories.
- **No raw sockets** — the only network access is through the `http-fetch` host function.
- **No environment variables** — nothing is inherited from the host.
- **No stdio** — output goes through the `log` host function, not stdout/stderr.
- **Domain allowlist** — `http-fetch` only reaches hosts in the module's `network_allowlist` (from the manifest) plus hosts extracted from `url`-type config fields. Redirects are disabled so a redirect can't escape the allowlist.
- **SSRF protection** — resolved IPs are checked against loopback, link-local (incl. cloud metadata `169.254.169.254`), unspecified, multicast, and broadcast ranges. Private LAN ranges are **allowed** (reaching self-hosted services is the point).
- **Port scoping** — a bare host entry matches only the scheme's default port (80/443), not all ports. A `host:port` entry matches only that exact port. This prevents an allowlist entry for a LAN host from being abused to reach Postgres or SSH on the same host.
- **Checksum verification** — when installing from a registry, the `.wasm` SHA-256 is verified against the `wasm_sha256` in `index.json`. Mismatched checksums are rejected.
- **Encrypted secrets** — secret-type config values are AES-256-GCM encrypted in the database. Modules receive them decrypted at runtime via `get-secret`; they never appear in `config_json`.
- **Resource limits** — fuel (instruction budget), memory cap, and wall-clock timeout prevent runaway modules. See [Resource Limits](#resource-limits).

---

## Module Lifecycle

1. **Install** — from a registry (Store UI) or via sideload (direct `.wasm` upload). The module is validated, the `.wasm` is stored on disk, and a row is inserted in the `modules` table.
2. **Configure** — the user fills in the auto-generated config form (rendered from `config_schema`). Secrets are encrypted; non-secret values are stored as JSON.
3. **Enable + schedule** — the user enables the module and sets a schedule (interval like `5m` / `300`, or a cron expression like `0 */6 * * * *`).
4. **Run** — the scheduler triggers runs, or the user triggers a manual run. Each run is recorded in `module_runs` with success/failure, metrics written, and logs.
5. **View** — metrics appear as widgets on the dashboard. Run history is visible in the Active Modules page.
6. **Update** — switch to a different GitHub release version via the Store UI. The manifest is re-fetched to pick up schema changes.
7. **Uninstall** — removes the `.wasm` from disk and deletes the DB row (cascading to config, runs, and metrics).

---

## Writing a Module from Scratch

### 1. Project setup

Create a new Rust project. It must be a **standalone crate** (not part of a workspace) because it targets `wasm32-wasip2`:

```bash
cargo new my-module --lib
cd my-module
```

Add the WIT bindings and serde dependencies to `Cargo.toml`:

```toml
# Standalone crate (not part of a workspace) — it targets wasm32-wasip2.
[workspace]

[package]
name = "my-module"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen = "=0.46.0"
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.145"

[profile.release]
opt-level = "s"
lto = true
strip = true
```

The `cdylib` crate type produces a `.wasm` file. The `opt-level = "s"` + `lto` + `strip` settings keep the binary small.

### 2. The WIT interface (host API contract)

The module communicates with ZFS Dashboard through a **WIT interface** — a typed contract that defines what functions the host provides and what the module exports.

Copy the WIT file from this repo into your module project:

```
my-module/
└── wit/
    └── module.wit    ← copy from rust-backend/wit/module.wit
```

The full interface:

```wit
package zfs-dashboard:module@0.1.0;

interface host-api {
    record http-response {
        status: u16,
        body: string,
    }

    http-fetch: func(url: string, headers: list<tuple<string, string>>) -> result<http-response, string>;
    db-write-metric: func(metric-name: string, value: f64) -> result<_, string>;
    get-secret: func(key: string) -> option<string>;
    log: func(level: string, message: string);
}

world module {
    import host-api;

    record run-result {
        success: bool,
        message: string,
        metrics-written: u32,
        error: option<string>,
    }

    export run: func(config-json: string) -> run-result;
}
```

The module **imports** `host-api` (functions provided by the host) and **exports** a `run` function (the module's entry point).

#### Host API functions

| Function | Description | Limits |
|---|---|---|
| `http-fetch(url, headers)` | GET request to an allowlisted URL. Returns `{ status, body }`. | Max 32 requests/run, 5 MiB response, no redirects, allowlist-enforced |
| `db-write-metric(name, value)` | Write a metric value (bound to this module's ID). | Max 1000/run, name 1-128 chars `[a-zA-Z0-9._-]` |
| `get-secret(key)` | Read a decrypted secret the user configured. Returns `none` if unset. | Secrets never appear in `config_json` |
| `log(level, message)` | Structured log line shown in run history. Level: `trace`, `debug`, `info`, `warn`, `error`. | Max 500 lines/run, 2048 bytes/line |

#### Module export

| Export | Description |
|---|---|
| `run(config-json) -> run-result` | Entry point. Called on every scheduled or manual run. `config-json` is the user's config as a JSON string (secrets excluded). Returns `{ success, message, metrics_written, error }`. |

### 3. Implementing `run`

Generate the WIT bindings and implement the `run` export:

```rust
// src/lib.rs

wit_bindgen::generate!({
    path: "wit",
    world: "module",
});

use serde::Deserialize;
use zfs_dashboard::module::host_api as host;

/// Config fields the user fills in via the auto-generated form.
/// These match the `config_schema` entries in your module.toml.
#[derive(Deserialize)]
struct Config {
    service_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default = "default_metrics")]
    metrics_to_collect: Vec<String>,
}

fn default_metrics() -> Vec<String> {
    vec!["items".into(), "users".into()]
}

/// Example: parse the API response from your external service.
#[derive(Deserialize)]
struct ServiceStats {
    #[serde(default)]
    items: f64,
    #[serde(default)]
    users: f64,
}

struct MyModule;

impl Guest for MyModule {
    fn run(config_json: String) -> RunResult {
        match collect(&config_json) {
            Ok(written) => RunResult {
                success: true,
                message: format!("collected {written} metrics"),
                metrics_written: written,
                error: None,
            },
            Err(e) => {
                host::log("error", &e);
                RunResult {
                    success: false,
                    message: String::new(),
                    metrics_written: 0,
                    error: Some(e),
                }
            }
        }
    }
}

fn collect(config_json: &str) -> Result<u32, String> {
    let config: Config =
        serde_json::from_str(config_json).map_err(|e| format!("invalid config: {e}"))?;

    let base = config.service_url.trim_end_matches('/');
    if base.is_empty() {
        host::log("info", "Service URL not configured. Skipping run.");
        return Ok(0);
    }

    let url = format!("{base}/api/stats");
    host::log("info", &format!("fetching {url}"));

    let headers = if config.api_key.is_empty() {
        vec![]
    } else {
        vec![("authorization".to_string(), format!("Bearer {}", config.api_key))]
    };

    let response = host::http_fetch(&url, &headers)?;
    if response.status != 200 {
        return Err(format!("service returned HTTP {}", response.status));
    }

    let stats: ServiceStats =
        serde_json::from_str(&response.body).map_err(|e| format!("unexpected response: {e}"))?;

    let mut written = 0u32;
    for metric in &config.metrics_to_collect {
        let (name, value) = match metric.as_str() {
            "items" => ("my-module.items", stats.items),
            "users" => ("my-module.users", stats.users),
            other => {
                host::log("warn", &format!("unknown metric {other:?} — skipping"));
                continue;
            }
        };
        host::db_write_metric(name, value)?;
        written += 1;
    }
    Ok(written)
}

export!(MyModule);
```

Key points:
- `config_json` contains **non-secret** config values only. Secrets come via `get-secret`.
- Use `host::log` for logging — it appears in the run history in the UI.
- Metric names should be namespaced (e.g. `my-module.items`) to avoid collisions.
- Return a `RunResult` with `success: false` and an `error` message on failure.

### 4. The manifest (`module.toml`)

Every module needs a `module.toml` manifest that declares its identity, permissions, config form, and widgets:

```toml
id = "my-module"
name = "My Module"
wasm_entrypoint = "my-module.wasm"

[permissions]
network_allowlist = []

[[config_schema]]
key = "service_url"
label = "Service URL"
type = "url"
required = true
description = "Base URL of the service to collect metrics from"

[[config_schema]]
key = "api_key"
label = "API Key"
type = "text"
required = false
description = "Bearer token for authentication"

[[config_schema]]
key = "metrics_to_collect"
label = "Metrics to collect"
type = "multiselect"
options = ["items", "users"]
default = ["items", "users"]
description = "Which metrics to write on every run"

[[config_schema]]
key = "schedule"
label = "Schedule"
type = "schedule"
default = "15m"
description = "Interval (e.g. 300, 15m, 2h) or cron expression (e.g. 0 0 * * * *)"
```

#### Manifest fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Module identifier. 1-64 chars, `[a-z0-9-_]` only. Must be globally unique. |
| `name` | string | yes | Display name. 1-128 chars. |
| `version` | string | no | Semantic version (max 32 chars). Filled from the GitHub release when installed via registry. |
| `author` | string | no | Author name. |
| `description` | string | no | Short description shown in the Store. |
| `icon` | string | no | Lucide icon name (e.g. `camera`, `database`, `cpu`). |
| `repository_url` | string | no | GitHub repository URL. Used for release listing and version switching. |
| `wasm_entrypoint` | string | yes | Filename of the `.wasm` artifact (e.g. `my-module.wasm`). Must end with `.wasm`, no path separators. |
| `permissions` | table | no | Network permissions. |
| `config_schema` | array | no | Config form field definitions. |
| `widget_schema` | array | no | Dashboard widget definitions. |
| `status_fields` | array | no | Status fields shown in Active Modules. |
| `actions` | array | no | Action buttons in Active Modules. |

#### `permissions`

| Field | Description |
|---|---|
| `network_allowlist` | List of allowed hosts (`"api.example.com"`) or `host:port` entries. Hosts from `url`-type config fields are added automatically at runtime. |

#### `config_schema` field types

| Type | Description |
|---|---|
| `text` | Plain text input |
| `url` | URL input — the host is automatically added to the network allowlist |
| `secret` | Password input — AES-256-GCM encrypted in the database, delivered via `get-secret` |
| `number` | Numeric input |
| `select` | Dropdown (requires `options`) |
| `multiselect` | Multi-select (requires `options`, stored as JSON array) |
| `schedule` | Schedule input — interval (`5m`, `300`) or cron (`0 */6 * * * *`). Minimum 30 seconds. |

#### `widget_schema` widget types

| Type | Description |
|---|---|
| `stat` | Single value card |
| `line` | Line chart |
| `bar` | Bar chart |
| `gauge` | Gauge indicator |
| `table` | Tabular data |

Example with widgets, status fields, and actions:

```toml
[[widget_schema]]
key = "items_chart"
label = "Items Over Time"
type = "line"
metrics = ["my-module.items"]
unit = "items"
color = "#22c55e"

[[status_fields]]
key = "current_items"
label = "Items"
metric = "my-module.items"
unit = "items"

[[actions]]
key = "refresh"
label = "Refresh Now"
icon = "refresh-cw"
description = "Trigger an immediate data collection run"
```

### 5. Building to `wasm32-wasip2`

Modules must be compiled as WebAssembly components targeting `wasm32-wasip2`:

```bash
# Add the target (one-time)
rustup target add wasm32-wasip2

# Build
cargo build --release --target wasm32-wasip2

# The output is at:
# target/wasm32-wasip2/release/my_module.wasm
```

Rename the output to match your `wasm_entrypoint`:

```bash
cp target/wasm32-wasip2/release/my_module.wasm my-module.wasm
```

---

## Publishing

### Registry index format

A registry is an `index.json` file hosted at a public URL. The default registry ships at [`registry/index.json`](../registry/index.json) in this repo and is served via GitHub raw content.

```json
{
  "modules": [
    {
      "id": "my-module",
      "name": "My Module",
      "author": "Your Name",
      "description": "Collects metrics from an external service.",
      "icon": "database",
      "repository_url": "https://github.com/your-name/my-module",
      "manifest_url": "https://raw.githubusercontent.com/your-name/my-module/main/module.toml",
      "wasm_url": "https://github.com/your-name/my-module/releases/latest/download/my-module.wasm",
      "wasm_sha256": "a1b2c3d4e5f6..."
    }
  ]
}
```

#### Fields

| Field | Description |
|---|---|
| `id` | Must match the `id` in `module.toml`. |
| `name`, `author`, `description`, `icon` | Display metadata (can differ from manifest). |
| `repository_url` | GitHub repo URL. Used for release listing and version switching in the Store UI. |
| `manifest_url` | Direct URL to the `module.toml` file (usually on `main` branch via `raw.githubusercontent.com`). |
| `wasm_url` | Direct URL to the `.wasm` artifact. Use `releases/latest/download/<name>.wasm` for the latest release. |
| `wasm_sha256` | SHA-256 hash of the `.wasm` file (64 hex chars). Verified on install. |

> **Note:** The `version` field is **not** needed in `index.json`. The store listing fetches the latest version from the GitHub releases API (`releases/latest`) at runtime — see [How downloads work](#how-downloads-work).

### Custom registries

Users can add custom registry URLs in the Module Store UI. A custom registry is just another `index.json` at any HTTPS URL. The backend fetches all configured registries and merges their modules (with duplicate resolution in the UI).

### Sideload (local/dev)

For local development or private modules, you can upload a `.wasm` directly without a registry:

1. Build your `.wasm` (see [Building](#5-building-to-wasm32-wasip2)).
2. In the dashboard, go to **Active Modules** and use the sideload feature.
3. Provide the `module.toml` content and the base64-encoded `.wasm`.

The sideload API endpoint is `POST /api/v1/modules/sideload` with a JSON body:

```json
{
  "manifest_toml": "<contents of module.toml>",
  "wasm_base64": "<base64-encoded .wasm>"
}
```

Sideloaded modules have `source = "sideload"` and no `registry_url`. They cannot be auto-updated — you must sideload a new version manually.

---

## Releases & GitHub Workflows

### How downloads work

When a user installs a module from the Store, the backend:

1. Fetches the registry `index.json` to find the module entry.
2. Downloads the `.wasm` from the `wasm_url` — which typically points to `https://github.com/<owner>/<repo>/releases/latest/download/<name>.wasm`. This URL always serves the **latest** GitHub Release asset.
3. Downloads the `module.toml` from the `manifest_url` to get the current manifest (config schema, permissions, etc.).
4. Verifies the SHA-256 checksum of the downloaded `.wasm` against `wasm_sha256` in `index.json`.
5. Stores the `.wasm` on disk and inserts the module into the database.

For **version switching** (updating to a specific older release), the Store UI fetches all releases via the GitHub API (`GET /api.github.com/repos/<owner>/<repo>/releases`) and lets the user pick. The selected release's `browser_download_url` is used to download that specific `.wasm` version.

This means:
- **The latest release** is always what new installs get (via `releases/latest/download/...`).
- **Specific versions** are available via the version picker (which queries the GitHub Releases API).
- **The `wasm_sha256` in `index.json`** must match the **latest** release's `.wasm` — update it whenever you cut a new release.
- **The version shown in the Store** is fetched live from `releases/latest` — no `version` field in `index.json` needed.

### Release workflow template

Create `.github/workflows/release.yml` in your module repo. This workflow builds the `.wasm` on every push to `main` and creates a GitHub Release with the artifact attached:

```yaml
name: Release Module

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install wasm32-wasip2 target
        run: rustup target add wasm32-wasip2

      - name: Build WASM module
        run: cargo build --release --target wasm32-wasip2

      - name: Create GitHub Release & attach WASM artifact
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: "v0.1.${{ github.run_number }}"
        run: |
          # Rename to match wasm_entrypoint in module.toml
          cp target/wasm32-wasip2/release/my_module.wasm my-module.wasm

          # Create the release with the .wasm attached
          gh release create "$TAG" my-module.wasm \
            --title "$TAG" \
            --notes "Release $TAG (commit ${{ github.sha }})"
```

**Important:** Adjust the `cp` line to match your crate name and `wasm_entrypoint`:
- Crate name in `Cargo.toml`: `my-module` → output file: `my_module.wasm` (hyphens become underscores)
- `wasm_entrypoint` in `module.toml`: `my-module.wasm` (the name you want)

### Creating a new release

The workflow above triggers automatically on every push to `main`. Each push creates a new release tagged `v0.1.<run_number>` (e.g. `v0.1.42`). The `.wasm` artifact is attached to the release.

If you prefer **manual versioning** (e.g. `v1.0.0`, `v1.1.0`), use this variant:

```yaml
name: Release Module

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install wasm32-wasip2 target
        run: rustup target add wasm32-wasip2

      - name: Build WASM module
        run: cargo build --release --target wasm32-wasip2

      - name: Create GitHub Release & attach WASM artifact
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          cp target/wasm32-wasip2/release/my_module.wasm my-module.wasm
          gh release create "${{ github.ref_name }}" my-module.wasm \
            --title "${{ github.ref_name }}" \
            --notes "Release ${{ github.ref_name }}"
```

With this variant, you create releases manually:

```bash
git tag v1.0.0
git push origin v1.0.0
# → workflow triggers, builds, and creates the release
```

### Updating the registry after a release

After a new release is built, you need to update `wasm_sha256` in the registry `index.json` so the checksum matches the new artifact:

```bash
# Download the new artifact from the release
gh release download v1.0.0 --repo your-name/my-module --output my-module.wasm

# Compute the SHA-256
sha256sum my-module.wasm
# → a1b2c3d4e5f6...  (64 hex chars)

# Update registry/index.json in the ZFS-Dashboard repo:
#   "wasm_sha256": "a1b2c3d4e5f6..."
```

The `wasm_url` does **not** need updating — `releases/latest/download/my-module.wasm` always points to the newest release automatically.

You can automate this with a workflow that updates the registry after a successful release, or do it manually. The key point: **`wasm_sha256` in `index.json` must always match the latest release's `.wasm`**, otherwise new installs will fail the checksum verification.

---

## Resource Limits

Per-run limits, configurable via environment variables on the ZFS Dashboard backend:

| Variable | Default | Description |
|---|---|---|
| `ZFS_MODULE_FUEL` | `2000000000` | Instruction budget (wasmtime fuel) |
| `ZFS_MODULE_MEMORY_BYTES` | `67108864` | Linear memory cap (64 MiB) |
| `ZFS_MODULE_TIMEOUT_SECS` | `30` | Wall-clock timeout |

Additional hard limits enforced by the host:

| Limit | Value | Description |
|---|---|---|
| Max HTTP requests per run | 32 | After this, `http-fetch` returns an error |
| Max HTTP response size | 5 MiB | Responses larger than this are rejected |
| Max metrics per run | 1000 | After this, `db-write-metric` returns an error |
| Max log lines per run | 500 | Additional log calls are silently dropped |
| Max log line length | 2048 bytes | Truncated on UTF-8 char boundary |
| Max manifest size | 64 KiB | `module.toml` larger than this is rejected |
| Max wasm size | 32 MiB | `.wasm` larger than this is rejected |
| Min schedule interval | 30 seconds | Shorter intervals are rejected |

---

## API Reference

All routes are prefixed with `/api/v1`.

### Store

| Method | Route | Description |
|---|---|---|
| `GET` | `/modules/store` | List available modules from all configured registries. Returns `{ modules: [...], errors: [...] }`. |
| `GET` | `/modules/registries` | List configured registries. |
| `POST` | `/modules/registries` | Add a custom registry URL. Body: `{ "url": "..." }`. |
| `DELETE` | `/modules/registries/:id` | Remove a custom registry (cannot remove the default, id=0). |
| `GET` | `/modules/releases?repository_url=...` | List GitHub releases for a module repo. Returns `{ releases: [{ tag_name, name, published_at, wasm_url }] }`. |

### Installation

| Method | Route | Description |
|---|---|---|
| `POST` | `/modules/install` | Install from registry. Body: `{ registry_url, id, version?, wasm_url? }`. |
| `POST` | `/modules/sideload` | Sideload a `.wasm` directly. Body: `{ manifest_toml, wasm_base64 }`. |
| `DELETE` | `/modules/:id` | Uninstall a module. |

### Active modules

| Method | Route | Description |
|---|---|---|
| `GET` | `/modules/active` | List installed modules with config, last run, and auto-discovered metrics. |
| `PUT` | `/modules/:id/config` | Update config and/or secrets. Body: `{ config: {...}, secrets: { key: "value" \| null } }`. |
| `POST` | `/modules/:id/enable` | Enable a module (allows scheduled runs). |
| `POST` | `/modules/:id/disable` | Disable a module. |
| `POST` | `/modules/:id/run` | Trigger a manual run. |
| `GET` | `/modules/:id/runs` | Run history. |
| `POST` | `/modules/:id/switch-version` | Switch to a different release version. Body: `{ version, wasm_url }`. |

### Metrics & actions

| Method | Route | Description |
|---|---|---|
| `GET` | `/modules/:id/metrics?interval=1h&metric=...` | Get metric time series. |
| `POST` | `/modules/:id/metrics` | Push metrics (used internally by the runtime). |
| `POST` | `/modules/:id/action/:action_key` | Trigger a module-defined action. |

### Module database

| Method | Route | Description |
|---|---|---|
| `GET` | `/modules/:id/database` | Get the module's database selection. |
| `PUT` | `/modules/:id/database` | Set the module's database selection. |
| `POST` | `/modules/:id/database/test` | Test the module's database connection. |

---

## Database Schema

The module system uses the following PostgreSQL tables (created by refinery migrations):

```sql
-- Configured registries (the default registry is id=0, not stored here)
CREATE TABLE module_registries (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Installed modules
CREATE TABLE modules (
    id TEXT PRIMARY KEY,          -- manifest id, e.g. "my-module"
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    repository_url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,         -- 'registry' or 'sideload'
    registry_url TEXT,            -- NULL for sideloaded modules
    wasm_sha256 TEXT NOT NULL,
    manifest JSONB NOT NULL,      -- full parsed module.toml
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-module config (non-secret values + encrypted secrets)
CREATE TABLE module_configs (
    module_id TEXT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE,
    config JSONB NOT NULL DEFAULT '{}',
    secrets BYTEA,                -- AES-256-GCM encrypted {key: value}
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Run history
CREATE TABLE module_runs (
    id BIGSERIAL PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    success BOOLEAN,              -- NULL while running
    message TEXT NOT NULL DEFAULT '',
    metrics_written INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL DEFAULT 'schedule'  -- 'schedule' or 'manual'
);

-- Metrics written by modules via db-write-metric
CREATE TABLE module_metrics (
    id BIGSERIAL PRIMARY KEY,
    module_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,    -- 1-128 chars [a-zA-Z0-9._-]
    value DOUBLE PRECISION NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log for module management actions
CREATE TABLE module_audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor TEXT NOT NULL,          -- 'admin' or 'api-key:<name>'
    action TEXT NOT NULL,         -- 'module_installed', 'registry_added', ...
    module_id TEXT,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
