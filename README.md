<div align="center">
  <h1>ZFS Dashboard</h1>
  <p>A modern, high-performance web dashboard for managing ZFS storage pools.</p>
  
  ![Rust](https://img.shields.io/badge/Rust-Axum-orange?style=flat-square) 
  ![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square) 
  ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=flat-square)
  ![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square)
  ![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square)
</div>

---

## 🌟 Overview

ZFS Dashboard (formerly ZFS Dashboard) is a completely reimagined, dark-themed control panel designed to bring enterprise-grade ZFS administration into a sleek, user-friendly interface. 

Built with a lightning-fast **Rust/Axum** backend and a dynamic **React + Tailwind** frontend, it provides real-time metrics, historical performance data, global notification rules, and complete control over your storage arrays.

---

## ✨ Key Features

### 📊 Advanced Performance Tracking (New)
- **Time-Series Metrics**: Integrated **PostgreSQL** database securely persists historical performance data (IOPS, Throughput, ARC hit ratio, Capacity).
- **Sub-second Real-time Monitoring**: High-frequency **Redis** caching pipeline fuels the live dashboard with real-time CPU, RAM, and disk utilization data without blocking ZFS commands.
- **Dynamic Forecasting**: Smart predictive algorithms estimate when your storage pools will run out of space based on historical consumption trends.

### 🧩 Extensible Module System (New)
- **HACS-style modules**: install community extensions that pull data from external services into your dashboard as metrics.
- **Sandboxed by design**: modules run as WebAssembly components with a minimal, host-enforced capability API — no native code, no free filesystem or network access.
- **Store + custom registries + sideload**, auto-generated config forms, schedules (interval or cron), and per-module run history.

### 🔔 Global Notification System
- Completely customizable **Notification Rules Engine**.
- Native support for **Discord, Telegram, and Email** webhooks.
- Get instant alerts on ZFS scrubs, dataset rewrites, disk replacements, and pool health degradation.

### 💽 Storage Pools & Disks
- Live pool list with health status, RAID-type badges (Mirror, RAIDZ-1/2/3, Stripe), fragmentation, and capacity.
- Deep disk inspection with **per-disk SMART data** viewer.
- **Action Menu**: Trigger ZFS Rewrites (rebalance), Expand Pools, Replace Disks, or run Scrubs with live progress tracking.
- **Pool Creation**: Intuitive VDEV type selector, ashift configuration, and force flags with a live terminal command preview.

### 📁 Datasets & Volumes
- Unified **Settings Popout**: Edit compression (lz4, zstd, gzip), quota, atime, dedup, and readonly attributes in a single, beautiful menu.
- **In-place Dataset Rewrite**: Rebalance datasets after compression changes with one click.
- Detects busy mounts/children when destroying datasets, offering safe Force + Recursive options.

### 📸 Snapshots
- Auto-naming schemas (`Pool-Dataset-YYYY-MM-DD`).
- One-click Snapshot Rollbacks and granular deletions.

---

## 🏗️ Architecture & Tech Stack

| Layer | Technologies |
|---|---|
| **Backend** | Rust, Axum 0.7, Tokio, Serde, tokio-postgres, refinery (migrations) |
| **Modules** | wasmtime (WebAssembly Component Model), WIT, AES-256-GCM secrets |
| **Frontend** | React 19, TypeScript, Vite 6, Tailwind CSS 4, Recharts, Framer Motion |
| **Datastore** | PostgreSQL 16 (Metrics History), Redis 7 (Live Cache & PubSub) |
| **Deployment**| Docker Compose, single app container, Alpine 3.20 (ZFS 2.2.5 ABI) |

### Single-container architecture

The backend and frontend ship as **one container**: a multi-stage build
compiles the React app to static assets, which Axum serves directly via
`tower-http::ServeDir` (with an `index.html` fallback for client-side routes).
Nginx is gone — one process, one port, no CORS split.

PostgreSQL and Redis stay as **separate services** on purpose: they have their
own lifecycle (upgrades, backups), persistent state, and battle-tested official
images. Merging them into the app container would gain nothing and complicate
signal handling and partial restarts.

---

## 🧩 Module System (HACS-style)

ZFS Dashboard can be extended with **modules** — community-buildable
extensions that fetch external data (e.g. from other self-hosted services) and
write it into the dashboard as metrics, à la Home Assistant + HACS.

Modules are written in Rust, compiled to a **WebAssembly component**, and run
**sandboxed** inside the backend. They are never native code and the server
**never compiles module source** — it only ever runs finished, checksum-verified
`.wasm` artifacts. See [SECURITY.md](SECURITY.md) for the full threat model.

- **Store** — browse and install modules from configured registries. A default
  registry ships built-in; you can add custom registry URLs in the UI.
- **Active Modules** — configure (via an auto-generated form), schedule
  (interval or cron), run on demand, and inspect run history per module.
- **Sideload** — build your own module locally and upload the `.wasm` directly,
  bypassing any registry.

The bundled [`modules/immich`](modules/immich) module is a complete example and
doubles as the **authoring guide** for writing your own.

**Module resource limits** (per run, overridable via env):

| Variable | Default | Description |
|---|---|---|
| `ZFS_MODULE_FUEL` | `2000000000` | Instruction budget (wasmtime fuel) |
| `ZFS_MODULE_MEMORY_BYTES` | `67108864` | Linear memory cap (64 MiB) |
| `ZFS_MODULE_TIMEOUT_SECS` | `30` | Wall-clock timeout |

---

## 🚀 Quick Start

Getting started is incredibly easy. The entire stack (Backend, Frontend, PostgreSQL, Redis) is orchestrated via Docker Compose.

### Prerequisites
- A Linux host with the ZFS kernel module loaded (`zfs-kmod` ≥ 2.0).
- Docker and Docker Compose installed.

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/ZFS-Dashboard/ZFS-Dashboard.git
cd ZFS-Dashboard

# 2. Configure secrets
cp .env.example .env   # then edit the passwords

# 3. Start the entire stack in the background
docker compose up -d --build
```

Open **http://localhost:8080** in your browser.
*(The default admin password is `admin123` — change it immediately.)*

---

## ⚙️ Configuration

Environment variables are set via a `.env` file (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | `admin123` | Admin login password. **Change this.** |
| `POSTGRES_PASSWORD` | `zfs_secret` | Password for the PostgreSQL metrics database. |
| `ZFS_WEB_PORT` | `8080` | Port the web UI + API is exposed on. |
| `ZFS_SECRETS_MASTER_KEY` | *(auto)* | Base64 32-byte key for module secret encryption. Auto-generated into the data dir when unset. |

> **Data directory**: hardcoded to `/app` inside the container (bind-mounted from `/home/zfs-manager` on the host). The entrypoint auto-migrates data from legacy paths (`/home/docker/zfs-manager`, `/home/zfs-manager`) on first start, so no env var is needed.

---

## ⚠️ Important Notes & Limitations

- **Product rename**: The project was renamed from **ZFS Manager** to **ZFS Dashboard**. The `ZFS_DASHBOARD_DATA` / `ZFS_MANAGER_DATA` env vars have been removed — the data directory is now hardcoded to `/app` inside the container, and the entrypoint migrates data from legacy paths automatically on first start. The ZFS user property `zfsDashboard:scrub_schedule` keeps its name so existing pools don't lose their scrub schedules.
- **Kernel Compatibility**: The container uses Alpine 3.20 (which ships ZFS 2.2.5). This provides the best compatibility for 2.2.x host kernels. If your host kernel module is 2.4.x, change `FROM alpine:3.20` to `FROM alpine:latest` in the root `Dockerfile`.
- **Privileged Mode**: The app container runs as `privileged: true` and mounts host paths (`/dev`, `/proc`, `/sys/module/zfs`) so the ZFS utilities inside the container can interact with your host's kernel and block devices. Because of this, **module code is treated as fully untrusted** and runs in a WebAssembly sandbox — see [SECURITY.md](SECURITY.md).

---

## 🛠️ Writing your own module

See [`modules/immich/README.md`](modules/immich/README.md) — it's a working
example and a step-by-step authoring guide (repo layout, the capability API,
manifest fields, building to `wasm32-wasip2`, and installing via sideload or a
registry).

---

## 📜 License

MIT License. See `LICENSE` for more information.
