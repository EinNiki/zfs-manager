-- Store WASM artifacts in PostgreSQL so they survive container restarts/rebuilds.
-- Previously WASM bytes were only written to /app/modules/ on the container's
-- ephemeral filesystem, which meant modules became unrunnable after a rebuild
-- even though their metadata persisted in the DB.
ALTER TABLE modules ADD COLUMN wasm_bytes BYTEA;
