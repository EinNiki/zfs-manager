#!/bin/sh
set -e

DATA_DIR="/app"
# Legacy in-container data paths from earlier image versions. Both are checked
# so installations coming from either the original (/home/docker/zfs-manager)
# or the intermediate rename (/home/zfs-manager) are migrated automatically.
LEGACY_DIRS="/home/docker/zfs-manager /home/zfs-manager"

# ── Migration from a legacy data path ────────────────────────────────────────
# Older images stored everything under one of the legacy paths below. If such a
# directory still holds user data (i.e. it is not just an empty placeholder) and
# the current DATA_DIR has not been initialized yet, copy the contents over so
# existing installations keep working without any manual host-side steps.
for LEGACY_DIR in $LEGACY_DIRS; do
    [ "$DATA_DIR" = "$LEGACY_DIR" ] && continue
    [ -d "$LEGACY_DIR" ] || continue

    legacy_has_data=0
    if [ -f "$LEGACY_DIR/.initialized" ]; then
        legacy_has_data=1
    elif [ -n "$(ls -A "$LEGACY_DIR" 2>/dev/null)" ]; then
        legacy_has_data=1
    fi

    if [ "$legacy_has_data" = "1" ] && [ ! -f "$DATA_DIR/.initialized" ]; then
        echo "entrypoint: migrating data from $LEGACY_DIR → $DATA_DIR"
        mkdir -p "$DATA_DIR"
        # Copy everything, including hidden files (.initialized, secrets.key, ...).
        cp -a "$LEGACY_DIR/." "$DATA_DIR/"
        # Clean up the legacy directory only if it is NOT a bind-mount
        # (rm -rf on a mountpoint would delete the host-side contents too).
        if ! mountpoint -q "$LEGACY_DIR" 2>/dev/null; then
            rm -rf "$LEGACY_DIR"
            mkdir -p "$LEGACY_DIR"
            touch "$LEGACY_DIR/.migrated"
        fi
        echo "entrypoint: migration complete"
    fi
done

# Ensure the data directory exists with correct permissions on first start
if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
fi

# Touch a marker so we know the volume has been initialized
if [ ! -f "$DATA_DIR/.initialized" ]; then
    touch "$DATA_DIR/.initialized"
fi

exec /usr/local/bin/zfs-dashboard "$@"
