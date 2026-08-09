# ── Stage 1: Frontend build ──────────────────────────────────────────────────
FROM node:22.12.0-alpine AS web-builder

WORKDIR /app
COPY web/package.json web/package-lock.json ./
# Native build tools for better-sqlite3 (dev dependency)
RUN apk add --no-cache python3 make g++ && npm ci && apk del python3 make g++
COPY web/ .
RUN npm run build

# ── Stage 2: Backend build ───────────────────────────────────────────────────
FROM rust:1.97-alpine AS backend-builder

RUN apk add --no-cache musl-dev gcc perl make

WORKDIR /app

# Cache dependencies first
COPY rust-backend/Cargo.toml rust-backend/Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && touch src/lib.rs
RUN cargo build --release 2>/dev/null || true
RUN rm -rf src

# ARG CACHEBUST: pass a new value (e.g. git commit hash) to force recompile
ARG CACHEBUST=1
RUN echo "Cache bust: $CACHEBUST"

COPY rust-backend/src ./src
COPY rust-backend/migrations ./migrations
COPY rust-backend/wit ./wit
RUN touch src/main.rs src/lib.rs && cargo build --release

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
# alpine:3.20 ships ZFS 2.2.5 which is ABI-compatible with the 2.2.x kernel module.
# alpine:latest/edge ships ZFS 2.4.x which breaks scrub against older kernel modules.
FROM alpine:3.20

RUN apk add --no-cache zfs util-linux smartmontools

COPY --from=backend-builder /app/target/release/zfs-dashboard /usr/local/bin/zfs-dashboard
COPY --from=web-builder /app/dist /usr/share/zfs-dashboard/web
COPY rust-backend/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Data directory is /app. The legacy paths are kept around only so the
# entrypoint migration can detect and move old data on existing installations
# that upgrade to this image.
RUN mkdir -p /app /home/docker/zfs-manager /home/zfs-manager

EXPOSE 3000

ENV ZFS_API_PORT=3000
ENV RUST_LOG=info
ENV ZFS_STATIC_DIR=/usr/share/zfs-dashboard/web

WORKDIR /app

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
