# Module System

ZFS Dashboard can be extended with **modules** — community-buildable extensions that fetch external data (e.g. from other self-hosted services) and write it into the dashboard as metrics. Think Home Assistant + HACS, but for storage infrastructure.

Modules are written in Rust, compiled to a **WebAssembly component**, and run **sandboxed** inside the backend. They are never native code, and the server never compiles module source — it only runs finished, checksum-verified `.wasm` artifacts.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Security Model](#security-model)
- [Module Lifecycle](#module-lifecycle)
- [Writing a Module](#writing-a-module)
  - [1. Project setup](#1-project-setup)
  - [2. The WIT interface](#2-the-wit-interface)
  - [3. Implementing `run`](#3-implementing-run)
  - [4. The manifest (`module.toml`)](#4-the-manifest-moduletoml)
  - [5. Building to `wasm32-wasip2`](#5-building-to-wasm32-wasip2)
- [Publishing](#publishing)
  - [Option A: Registry](#option-a-registry)
  - [Option B: Sideload](#option-b-sideload)
- [Resource Limits](#resource-limits)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Example: Immich Stats Module](#example-immich-stats-module)

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

## Writing a Module

### 1. Project setup

Create a new Rust project:

```bash
cargo new immich-module --lib
cd immich-module
```

Add the WIT bindings and wasmtime guest dependencies to `Cargo.toml`:

```toml
[package]
name = "immich-module"
version = "1.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen = "0.30"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Copy the WIT interface definition from this repo (`rust-backend/wit/module.wit`) into your module project at `wit/module.wit`. This defines the host API contract.

### 2. The WIT interface

The full interface is defined in [`rust-backend/wit/module.wit`](../rust-backend/wit/module.wit):

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

### 3. Implementing `run`

Generate the bindings and implement the `run` export. Here is the real implementation from the [immich-module](https://github.com/ZFS-Dashboard/immich-module) repo:

```rust
// src/lib.rs

wit_bindgen::generate!({
    path: "wit",
    world: "module",
});

use serde::Deserialize;
use zfs_dashboard::module::host_api as host;

#[derive(Deserialize)]
struct Config {
    immich_url: String,
    #[serde(default)]
    immich_api_key: String,
    #[serde(default = "default_stats")]
    stats_to_fetch: Vec<String>,
}

fn default_stats() -> Vec<String> {
    vec!["photos".into(), "videos".into(), "usage".into(), "users".into()]
}

/// Shape of Immich's GET /api/server/statistics response (fields we use).
#[derive(Deserialize)]
struct ServerStatistics {
    #[serde(default)]
    photos: f64,
    #[serde(default)]
    videos: f64,
    #[serde(default)]
    usage: f64,
    #[serde(default, rename = "usageByUser")]
    usage_by_user: Vec<serde_json::Value>,
}

struct ImmichModule;

impl Guest for ImmichModule {
    fn run(config_json: String) -> RunResult {
        match collect(&config_json) {
            Ok(written) => RunResult {
                success: true,
                message: format!("collected {written} Immich metrics"),
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

    let base = config.immich_url.trim_end_matches('/');
    if base.is_empty() {
        host::log("info", "Immich URL is not configured. Skipping run.");
        return Ok(0);
    }

    let api_key = config.immich_api_key;
    if api_key.is_empty() {
        host::log("info", "Immich API key is not configured. Skipping run.");
        return Ok(0);
    }

    let url = format!("{base}/api/server/statistics");
    host::log("info", &format!("fetching {url}"));

    let response = host::http_fetch(&url, &[("x-api-key".to_string(), api_key)])?;
    if response.status != 200 {
        return Err(format!("Immich returned HTTP {}", response.status));
    }
    let stats: ServerStatistics =
        serde_json::from_str(&response.body).map_err(|e| format!("unexpected response: {e}"))?;

    let mut written = 0u32;
    for stat in &config.stats_to_fetch {
        let (metric, value) = match stat.as_str() {
            "photos" => ("immich.photos", stats.photos),
            "videos" => ("immich.videos", stats.videos),
            "usage" => ("immich.usage_bytes", stats.usage),
            "users" => ("immich.users", stats.usage_by_user.len() as f64),
            other => {
                host::log("warn", &format!("unknown stat {other:?} — skipping"));
                continue;
            }
        };
        host::db_write_metric(metric, value)?;
        written += 1;
    }
    Ok(written)
}

export!(ImmichModule);
```

### 4. The manifest (`module.toml`)

Every module needs a `module.toml` manifest that declares its identity, permissions, config form, and widgets. Here is the real manifest from the immich-module:

```toml
id = "immich"
name = "Immich Stats"
wasm_entrypoint = "immich.wasm"

[permissions]
network_allowlist = []

[[config_schema]]
key = "immich_url"
label = "Immich URL"
type = "url"
required = true
description = "Base URL of your Immich server, e.g. http://immich.local:2283"

[[config_schema]]
key = "immich_api_key"
label = "Immich API Key"
type = "text"
required = true
description = "API key created in Immich under Account Settings > API Keys"

[[config_schema]]
key = "stats_to_fetch"
label = "Statistics to collect"
type = "multiselect"
options = ["photos", "videos", "usage", "users"]
default = ["photos", "videos", "usage", "users"]
description = "Which metrics to write on every run"

[[config_schema]]
key = "schedule"
label = "Schedule"
type = "schedule"
default = "15m"
description = "Interval (e.g. 300, 15m, 2h) or cron expression (e.g. 0 0 * * * *)"
```

A more complex module might also declare widgets, status fields, and actions:

```toml
[[widget_schema]]
key = "photos"
label = "Photos"
type = "stat"
metrics = ["immich.photos"]
unit = "items"

[[widget_schema]]
key = "storage_chart"
label = "Storage Usage"
type = "line"
metrics = ["immich.usage_bytes"]
unit = "bytes"
color = "#22c55e"

[[status_fields]]
key = "last_photos"
label = "Photos"
metric = "immich.photos"
unit = "items"

[[actions]]
key = "refresh"
label = "Refresh Now"
icon = "refresh-cw"
description = "Trigger an immediate data collection run"
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
| `wasm_entrypoint` | string | yes | Filename of the `.wasm` artifact (e.g. `immich.wasm`). Must end with `.wasm`, no path separators. |
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

### 5. Building to `wasm32-wasip2`

Modules must be compiled as WebAssembly components targeting `wasm32-wasip2`:

```bash
# Add the target
rustup target add wasm32-wasip2

# Build
cargo build --target wasm32-wasip2 --release

# The output is at:
# target/wasm32-wasip2/release/immich_module.wasm
```

Rename the output to match your `wasm_entrypoint`:

```bash
cp target/wasm32-wasip2/release/immich_module.wasm immich.wasm
```

---

## Publishing

### Option A: Registry

A registry is an `index.json` file hosted at a public URL. The default registry ships at [`registry/index.json`](../registry/index.json) in this repo.

#### `index.json` format

```json
{
  "modules": [
    {
      "id": "immich",
      "name": "Immich Stats",
      "author": "ZFS Dashboard",
      "description": "Collects statistics from an Immich server.",
      "icon": "camera",
      "repository_url": "https://github.com/ZFS-Dashboard/immich-module",
      "manifest_url": "https://raw.githubusercontent.com/ZFS-Dashboard/immich-module/main/module.toml",
      "wasm_url": "https://github.com/ZFS-Dashboard/immich-module/releases/latest/download/immich.wasm",
      "wasm_sha256": "1d1a2fbf0b774bb011dc891bd309012bbc787130327eb22436a42136eebf756d"
    }
  ]
}
```

#### Fields

| Field | Description |
|---|---|
| `id` | Must match the `id` in `module.toml`. |
| `name`, `author`, `description`, `icon` | Display metadata (can differ from manifest). |
| `repository_url` | GitHub repo URL. Used for release listing and version switching. |
| `manifest_url` | Direct URL to the `module.toml` file. |
| `wasm_url` | Direct URL to the `.wasm` artifact. Use `releases/latest/download/...` for the latest release. |
| `wasm_sha256` | SHA-256 hash of the `.wasm` file (64 hex chars). Verified on install. |

> **Note:** The `version` field is **not** needed in `index.json`. The store listing fetches the latest version from the GitHub releases API (`releases/latest`) at runtime.

#### Steps to publish

1. Create a GitHub repository for your module (e.g. `ZFS-Dashboard/immich-module`).
2. Push your `module.toml` and source code to the `main` branch.
3. Create a GitHub Release with the `.wasm` file as an asset.
4. Compute the SHA-256: `sha256sum immich.wasm`
5. Add an entry to the registry `index.json` (or your custom registry) with the URLs and checksum.
6. The `manifest_url` should point to `module.toml` on `main`, and `wasm_url` to `releases/latest/download/immich.wasm`.

#### Custom registries

Users can add custom registry URLs in the Module Store UI. A custom registry is just another `index.json` at any HTTPS URL. The backend fetches all configured registries and merges their modules (with duplicate resolution in the UI).

### Option B: Sideload

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

## Resource Limits

Per-run limits, configurable via environment variables:

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
    id TEXT PRIMARY KEY,          -- manifest id, e.g. "immich"
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

---

## Example: Immich Stats Module

The [immich-module](https://github.com/ZFS-Dashboard/immich-module) is the reference module — it doubles as the authoring template. It collects statistics from an [Immich](https://immich.app) server and writes them as dashboard metrics.

### What it does

Every scheduled run it calls `GET /api/server/statistics` on the configured Immich server and writes the selected metrics:

| Metric | Meaning |
|---|---|
| `immich.photos` | Total number of photos |
| `immich.videos` | Total number of videos |
| `immich.usage_bytes` | Storage used by Immich |
| `immich.users` | Number of users |

### Configuration

| Field | Type | Description |
|---|---|---|
| `immich_url` | url | Base URL, e.g. `http://immich.local:2283` |
| `immich_api_key` | text | API key from Immich Account Settings → API Keys |
| `stats_to_fetch` | multiselect | Which of the metrics to write (photos, videos, usage, users) |
| `schedule` | schedule | Interval (`300`, `15m`, `2h`) or cron (`0 0 * * * *`) |

### Repository layout

```
immich-module/
├── Cargo.toml        # crate-type = ["cdylib"], dep: wit-bindgen
├── module.toml       # manifest: identity, permissions, config schema
├── wit/module.wit    # copy of the host interface (see rust-backend/wit/)
└── src/lib.rs        # module logic
```

### Cargo.toml

```toml
[workspace]

[package]
name = "zfs-dashboard-module-immich"
version = "1.0.0"
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

### Source code

The full `src/lib.rs` is shown in [Section 3: Implementing `run`](#3-implementing-run) above. The key flow is:

1. Parse `config_json` to get the Immich URL, API key, and which stats to fetch.
2. Call `http_fetch` with the `x-api-key` header to `GET /api/server/statistics`.
3. Parse the JSON response and write each selected metric via `db_write_metric`.
4. Return a `RunResult` with success/failure and the number of metrics written.

### Building

```bash
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2
# → target/wasm32-wasip2/release/zfs_dashboard_module_immich.wasm
```

Rename to match `wasm_entrypoint`:

```bash
cp target/wasm32-wasip2/release/zfs_dashboard_module_immich.wasm immich.wasm
```

### Publishing

The immich-module is published via GitHub Releases. The registry entry in [`registry/index.json`](../registry/index.json) points to:

- `manifest_url` → `module.toml` on the `main` branch
- `wasm_url` → `releases/latest/download/immich.wasm` (always the latest release)
- `wasm_sha256` → SHA-256 of the current release artifact

To create a new release:

1. Tag a new version: `git tag v1.1.0 && git push origin v1.1.0`
2. Create a GitHub Release and attach the built `immich.wasm`.
3. Update `wasm_sha256` in `registry/index.json` with the new checksum (`sha256sum immich.wasm`).

The version shown in the Store UI is fetched live from the GitHub releases API — no `version` field in `index.json` needed.
