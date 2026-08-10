# ZFS Dashboard Documentation

This directory contains the technical documentation for ZFS Dashboard.

## Documents

| Document | Description |
|---|---|
| [MODULES.md](MODULES.md) | Module system architecture, authoring guide, and API reference |

## Project Overview

ZFS Dashboard is a web-based control panel for managing ZFS storage pools. It is built as a single Docker container that bundles a Rust/Axum backend and a React frontend, with PostgreSQL and Redis as separate services.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                  zfs-dashboard container             │
│                                                      │
│  ┌──────────────┐    ┌────────────────────────────┐ │
│  │  Axum (Rust)  │───▶│  React SPA (static assets) │ │
│  │  :3000        │    │  served via tower-http     │ │
│  └──────┬───────┘    └────────────────────────────┘ │
│         │                                            │
│         ├── ZFS commands (zpool, zfs, smartctl)      │
│         ├── Module runtime (wasmtime sandbox)        │
│         └── Migrations (refinery)                    │
└─────────┼──────────────────────────┬─────────────────┘
          │                          │
          ▼                          ▼
  ┌──────────────┐          ┌──────────────┐
  │  PostgreSQL  │          │    Redis     │
  │  (metrics,   │          │  (live cache,│
  │   modules)   │          │   pubsub)    │
  └──────────────┘          └──────────────┘
```

### Tech Stack

| Layer | Technologies |
|---|---|
| **Backend** | Rust, Axum 0.7, Tokio, Serde, tokio-postgres, refinery |
| **Modules** | wasmtime (WebAssembly Component Model), WIT, AES-256-GCM secrets |
| **Frontend** | React 19, TypeScript, Vite 6, Tailwind CSS 4, Recharts, Framer Motion |
| **Datastore** | PostgreSQL 16 (metrics history, module state), Redis 7 (live cache & pubsub) |
| **Deployment** | Docker Compose, single app container, Alpine 3.20 (ZFS 2.2.5 ABI) |

### Single-container design

The backend and frontend ship as **one container**: a multi-stage Docker build compiles the React app to static assets, which Axum serves directly via `tower-http::ServeDir` (with an `index.html` fallback for client-side routes). There is no Nginx or separate web server — one process, one port (3000 internally, mapped to `ZFS_WEB_PORT` on the host).

PostgreSQL and Redis are separate services with their own lifecycle, persistent state, and official images.

### Data directory

The data directory is hardcoded to `/app` inside the container. You bind-mount it to any host directory you like (configured in `compose.yaml`) — e.g. `/home/zfs-dashboard`, `/opt/zfs-dashboard`, `/ssd/zfs-dashboard`, etc. It stores:

- `secrets.key` — auto-generated AES-256 master key for module secret encryption (if `ZFS_SECRETS_MASTER_KEY` is not set)
- `modules/` — installed `.wasm` artifacts

The entrypoint auto-migrates data from legacy paths on first start.

## Deployment

### Prerequisites

- A Linux host with the ZFS kernel module loaded (`zfs-kmod` >= 2.0)
- Docker and Docker Compose installed

### Installation

```bash
git clone https://github.com/ZFS-Dashboard/ZFS-Dashboard.git
cd ZFS-Dashboard
cp .env.example .env   # edit passwords
docker compose up -d --build
```

Open `http://localhost:8080` in your browser. The default admin password is `admin123` — change it immediately.

### Configuration

Environment variables are set via `.env` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | `admin123` | Admin login password. **Change this.** |
| `POSTGRES_PASSWORD` | `zfs_secret` | Password for the PostgreSQL metrics database. |
| `ZFS_WEB_PORT` | `8080` | Port the web UI + API is exposed on. |
| `ZFS_SECRETS_MASTER_KEY` | *(auto)* | Base64 32-byte key for module secret encryption. Auto-generated into the data dir when unset. Generate with: `openssl rand -base64 32` |
| `ZFS_MODULE_FUEL` | `2000000000` | Module instruction budget (wasmtime fuel) |
| `ZFS_MODULE_MEMORY_BYTES` | `67108864` | Module linear memory cap (64 MiB) |
| `ZFS_MODULE_TIMEOUT_SECS` | `30` | Module wall-clock timeout |

### Kernel compatibility

The container uses Alpine 3.20 (ZFS 2.2.5), compatible with 2.2.x host kernels. For 2.4.x host kernels, change `FROM alpine:3.20` to `FROM alpine:latest` in the `Dockerfile`.

### Privileged mode

The app container runs as `privileged: true` and mounts host paths (`/dev`, `/proc`, `/sys/module/zfs`) so ZFS utilities can interact with the host kernel and block devices. Because of this, module code is treated as fully untrusted and runs in a WebAssembly sandbox — see [MODULES.md](MODULES.md).

## API

All API routes are prefixed with `/api/v1/`. The frontend communicates with the backend over this single port (no CORS split).

Key endpoints:

| Area | Endpoints |
|---|---|
| Health | `GET /api/v1/health` |
| Pools | `/api/v1/pools/...` |
| Datasets | `/api/v1/datasets/...` |
| Snapshots | `/api/v1/snapshots/...` |
| Disks | `/api/v1/disks/...` |
| Performance | `/api/v1/performance/...` |
| Notifications | `/api/v1/notifications/...` |
| Modules | `/api/v1/modules/...` (see [MODULES.md](MODULES.md)) |

## License

MIT License. See `LICENSE` in the repository root.
