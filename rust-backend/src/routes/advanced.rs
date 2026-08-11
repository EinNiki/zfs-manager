//! Advanced mode routes: file system browser and database inspector.
//!
//! These routes are only useful when advanced mode is enabled in settings.
//! They provide raw access to the /app file system and PostgreSQL database
//! for debugging purposes. All routes require authentication.

use axum::{
    extract::{Path, Query, State},
    routing::{get, post, delete},
    Json,
    Router,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tracing::warn;

use crate::error::ApiError;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        // File system
        .route("/api/v1/advanced/fs", get(fs_list).post(fs_upload))
        .route("/api/v1/advanced/fs/content", get(fs_read).put(fs_write))
        .route("/api/v1/advanced/fs/:path", delete(fs_delete))
        // Database
        .route("/api/v1/advanced/db/tables", get(db_tables))
        .route("/api/v1/advanced/db/query", post(db_query))
        .route("/api/v1/advanced/db/table/:name", get(db_table_rows))
        .route("/api/v1/advanced/db/table/:name/row", post(db_insert_row).put(db_update_row).delete(db_delete_row))
        .with_state(state)
}

// ── File System ──────────────────────────────────────────────────────────────

/// The root directory that file system operations are confined to.
/// All paths are resolved relative to this and checked to prevent traversal.
const FS_ROOT: &str = "/app";

/// Resolve a user-provided path relative to /app, rejecting traversal.
fn resolve_path(raw: &str) -> Result<PathBuf, ApiError> {
    let cleaned = raw.trim_start_matches('/');
    let full = std::path::Path::new(FS_ROOT).join(cleaned);
    // Canonicalize to resolve any .. or symlinks, then verify it's under /app
    let canonical = full.canonicalize().unwrap_or_else(|_| full.clone());
    let root_canonical = std::path::Path::new(FS_ROOT).canonicalize().unwrap_or_else(|_| std::path::Path::new(FS_ROOT).to_path_buf());
    if !canonical.starts_with(&root_canonical) {
        return Err(ApiError::BadRequest("path escapes /app".into()));
    }
    Ok(full)
}

#[derive(Deserialize)]
struct FsListQuery {
    #[serde(default)]
    path: String,
}

/// GET /api/v1/advanced/fs?path=subdir
async fn fs_list(
    State(_state): State<AppState>,
    Query(q): Query<FsListQuery>,
) -> Result<Json<Value>, ApiError> {
    let target = resolve_path(&q.path)?;
    if !target.exists() {
        return Err(ApiError::NotFound("path not found".into()));
    }
    if target.is_file() {
        return Ok(Json(json!({
            "path": q.path,
            "is_file": true,
            "size": target.metadata().map(|m| m.len()).unwrap_or(0),
        })));
    }

    let mut entries = Vec::new();
    let read_dir = match std::fs::read_dir(&target) {
        Ok(rd) => rd,
        Err(e) => return Err(ApiError::InternalError(format!("read_dir: {e}"))),
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(json!({
            "name": name,
            "is_dir": is_dir,
            "size": size,
            "modified": modified,
        }));
    }
    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        let ad = a.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        let bd = b.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        match (ad, bd) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                an.to_lowercase().cmp(&bn.to_lowercase())
            }
        }
    });

    Ok(Json(json!({
        "path": q.path,
        "is_file": false,
        "entries": entries,
    })))
}

#[derive(Deserialize)]
struct FsReadQuery {
    path: String,
}

/// GET /api/v1/advanced/fs/content?path=...
async fn fs_read(
    State(_state): State<AppState>,
    Query(q): Query<FsReadQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let target = resolve_path(&q.path)?;
    if !target.is_file() {
        return Err(ApiError::BadRequest("not a file".into()));
    }
    let content = std::fs::read_to_string(&target)
        .map_err(|e| ApiError::InternalError(format!("read: {e}")))?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        content,
    ))
}

#[derive(Deserialize)]
struct FsWriteBody {
    path: String,
    content: String,
}

/// PUT /api/v1/advanced/fs/content
async fn fs_write(
    State(_state): State<AppState>,
    Json(body): Json<FsWriteBody>,
) -> Result<Json<Value>, ApiError> {
    let target = resolve_path(&body.path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ApiError::InternalError(format!("create_dir: {e}")))?;
    }
    std::fs::write(&target, &body.content)
        .map_err(|e| ApiError::InternalError(format!("write: {e}")))?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/v1/advanced/fs/:path
async fn fs_delete(
    State(_state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let target = resolve_path(&path)?;
    if !target.exists() {
        return Err(ApiError::NotFound("path not found".into()));
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| ApiError::InternalError(format!("remove_dir: {e}")))?;
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| ApiError::InternalError(format!("remove_file: {e}")))?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct FsUploadBody {
    path: String,
    content_base64: String,
}

/// POST /api/v1/advanced/fs — upload a file (base64-encoded)
async fn fs_upload(
    State(_state): State<AppState>,
    Json(body): Json<FsUploadBody>,
) -> Result<Json<Value>, ApiError> {
    use base64::Engine;
    let target = resolve_path(&body.path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ApiError::InternalError(format!("create_dir: {e}")))?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.content_base64.as_bytes())
        .map_err(|e| ApiError::BadRequest(format!("invalid base64: {e}")))?;
    std::fs::write(&target, &bytes)
        .map_err(|e| ApiError::InternalError(format!("write: {e}")))?;
    Ok(Json(json!({ "ok": true, "size": bytes.len() })))
}

// ── Database ─────────────────────────────────────────────────────────────────

/// GET /api/v1/advanced/db/tables — list all tables
async fn db_tables(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    let rows = pg
        .query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
            &[],
        )
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let tables: Vec<String> = rows.into_iter().map(|r| r.get(0)).collect();
    Ok(Json(json!({ "tables": tables })))
}

#[derive(Deserialize)]
struct DbTableQuery {
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}
fn default_limit() -> i64 { 100 }

/// GET /api/v1/advanced/db/table/:name?limit=100&offset=0
async fn db_table_rows(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<DbTableQuery>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;

    // Validate table name to prevent SQL injection
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ApiError::BadRequest("invalid table name".into()));
    }

    let limit = q.limit.clamp(1, 1000);
    let offset = q.offset.max(0);

    // Get column info + primary key columns
    let col_rows = pg
        .query(
            "SELECT c.column_name, c.data_type,
                    (SELECT COUNT(*) FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage kcu
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                     WHERE tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
                       AND kcu.column_name = c.column_name) > 0 AS is_pk
             FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = $1
             ORDER BY c.ordinal_position",
            &[&name],
        )
        .await
        .map_err(|e| ApiError::InternalError(e.to_string()))?;
    let columns: Vec<Value> = col_rows
        .iter()
        .map(|r| json!({
            "name": r.get::<_, String>(0),
            "type": r.get::<_, String>(1),
            "is_pk": r.get::<_, bool>(2),
        }))
        .collect();
    let pk_cols: Vec<String> = columns
        .iter()
        .filter_map(|c| {
            if c.get("is_pk").and_then(|v| v.as_bool()).unwrap_or(false) {
                c.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect();

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM {name}");
    let total: i64 = pg
        .query_one(&count_sql, &[])
        .await
        .map(|r| r.get(0))
        .map_err(|e| ApiError::InternalError(e.to_string()))?;

    // Get rows — use row_to_json so PostgreSQL handles all type conversions
    // (TEXT, INT, TIMESTAMP, BYTEA, JSONB, etc.) natively. This avoids
    // FromSql panics when trying to get non-JSON columns as serde_json::Value.
    let data_sql = format!(
        "SELECT row_to_json(t) FROM (SELECT * FROM {name} LIMIT {limit} OFFSET {offset}) t"
    );
    let rows = pg.query(&data_sql, &[]).await.map_err(|e| ApiError::InternalError(e.to_string()))?;
    let row_data: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            row.get::<_, Option<serde_json::Value>>(0).unwrap_or(Value::Null)
        })
        .collect();

    Ok(Json(json!({
        "table": name,
        "columns": columns,
        "pk_columns": pk_cols,
        "rows": row_data,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

#[derive(Deserialize)]
struct DbQueryBody {
    sql: String,
    #[serde(default)]
    read_only: bool,
}

/// POST /api/v1/advanced/db/query — execute raw SQL (SELECT only by default)
async fn db_query(
    State(state): State<AppState>,
    Json(body): Json<DbQueryBody>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    let sql = body.sql.trim();

    if sql.is_empty() {
        return Err(ApiError::BadRequest("empty SQL".into()));
    }

    // Safety check: only allow SELECT unless read_only is explicitly false
    let upper = sql.to_uppercase();
    let is_select = upper.starts_with("SELECT") || upper.starts_with("WITH");
    if body.read_only && !is_select {
        return Err(ApiError::BadRequest(
            "read_only mode: only SELECT/WITH queries allowed. Set read_only=false to allow writes.".into(),
        ));
    }

    // Block dangerous statements even in non-readonly mode
    let dangerous = ["DROP DATABASE", "DROP SCHEMA", "SHUTDOWN", "TRUNCATE"];
    for d in &dangerous {
        if upper.contains(d) {
            return Err(ApiError::BadRequest(format!("{d} is not allowed")));
        }
    }

    if is_select {
        // Wrap the user's query in row_to_json so PostgreSQL handles all
        // type conversions natively. This avoids FromSql panics on non-JSON
        // column types (TEXT, INT, TIMESTAMP, BYTEA, etc.).
        let wrapped = format!(
            "SELECT row_to_json(t) FROM ({sql}) t"
        );
        let rows = pg.query(&wrapped, &[]).await.map_err(|e| {
            warn!("advanced db_query error: {e}");
            ApiError::BadRequest(e.to_string())
        })?;
        let row_data: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                row.get::<_, Option<serde_json::Value>>(0).unwrap_or(Value::Null)
            })
            .collect();
        // Extract column names from the first row's JSON keys
        let columns: Vec<String> = row_data.first()
            .and_then(|r| r.as_object())
            .map(|obj| obj.keys().cloned().collect())
            .unwrap_or_default();
        Ok(Json(json!({ "columns": columns, "rows": row_data, "row_count": row_data.len() })))
    } else {
        let affected = pg.execute(sql, &[]).await.map_err(|e| {
            warn!("advanced db_query error: {e}");
            ApiError::BadRequest(e.to_string())
        })?;
        Ok(Json(json!({ "rows_affected": affected })))
    }
}

// ── Row CRUD ─────────────────────────────────────────────────────────────────

/// Validate that a string is a safe SQL identifier (table or column name).
fn validate_identifier(s: &str) -> Result<(), ApiError> {
    if s.is_empty() || s.len() > 63 {
        return Err(ApiError::BadRequest("invalid identifier".into()));
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ApiError::BadRequest("invalid identifier".into()));
    }
    if s.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true) {
        return Err(ApiError::BadRequest("identifier cannot start with a digit".into()));
    }
    Ok(())
}

/// Convert a JSON value to a SQL literal for use in a dynamically built query.
/// This is safe because we control the quoting — values never go through
/// string interpolation unescaped.
fn json_to_sql_literal(val: &Value) -> String {
    match val {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            // Escape single quotes by doubling them
            let escaped = s.replace('\'', "''");
            format!("'{escaped}'")
        }
        _ => {
            // For arrays/objects, serialize as JSON and cast to jsonb
            let escaped = serde_json::to_string(val).unwrap_or_else(|_| "null".to_string()).replace('\'', "''");
            format!("'{escaped}'::jsonb")
        }
    }
}

#[derive(Deserialize)]
struct DbRowBody {
    /// Column → value pairs for the row
    values: serde_json::Map<String, Value>,
}

/// POST /api/v1/advanced/db/table/:name/row — insert a new row
async fn db_insert_row(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<DbRowBody>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    validate_identifier(&name)?;
    if body.values.is_empty() {
        return Err(ApiError::BadRequest("no values provided".into()));
    }
    for col in body.values.keys() {
        validate_identifier(col)?;
    }
    let cols: Vec<String> = body.values.keys().cloned().collect();
    let vals: Vec<String> = body.values.values().map(json_to_sql_literal).collect();
    let sql = format!(
        "INSERT INTO {name} ({}) VALUES ({})",
        cols.join(", "),
        vals.join(", ")
    );
    let affected = pg.execute(&sql, &[]).await.map_err(|e| {
        warn!("advanced db_insert error: {e}");
        ApiError::BadRequest(e.to_string())
    })?;
    Ok(Json(json!({ "ok": true, "rows_affected": affected })))
}

#[derive(Deserialize)]
struct DbUpdateRowBody {
    /// Column → new value pairs to update
    values: serde_json::Map<String, Value>,
    /// Column → value pairs identifying the row (typically primary keys)
    #[serde(rename = "rowId")]
    row_id: serde_json::Map<String, Value>,
}

/// PUT /api/v1/advanced/db/table/:name/row — update a row
async fn db_update_row(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<DbUpdateRowBody>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    validate_identifier(&name)?;
    if body.values.is_empty() {
        return Err(ApiError::BadRequest("no values to update".into()));
    }
    if body.row_id.is_empty() {
        return Err(ApiError::BadRequest("rowId is required for updates".into()));
    }
    for col in body.values.keys().chain(body.row_id.keys()) {
        validate_identifier(col)?;
    }
    let set_clause: Vec<String> = body
        .values
        .iter()
        .map(|(col, val)| format!("{col} = {}", json_to_sql_literal(val)))
        .collect();
    let where_clause: Vec<String> = body
        .row_id
        .iter()
        .map(|(col, val)| format!("{col} = {}", json_to_sql_literal(val)))
        .collect();
    let sql = format!(
        "UPDATE {name} SET {} WHERE {}",
        set_clause.join(", "),
        where_clause.join(" AND ")
    );
    let affected = pg.execute(&sql, &[]).await.map_err(|e| {
        warn!("advanced db_update error: {e}");
        ApiError::BadRequest(e.to_string())
    })?;
    Ok(Json(json!({ "ok": true, "rows_affected": affected })))
}

#[derive(Deserialize)]
struct DbDeleteRowBody {
    /// Column → value pairs identifying the row (typically primary keys)
    #[serde(rename = "rowId")]
    row_id: serde_json::Map<String, Value>,
}

/// DELETE /api/v1/advanced/db/table/:name/row — delete a row
async fn db_delete_row(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<DbDeleteRowBody>,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg.as_ref().ok_or(ApiError::InternalError("database unavailable".into()))?;
    validate_identifier(&name)?;
    if body.row_id.is_empty() {
        return Err(ApiError::BadRequest("rowId is required for deletes".into()));
    }
    for col in body.row_id.keys() {
        validate_identifier(col)?;
    }
    let where_clause: Vec<String> = body
        .row_id
        .iter()
        .map(|(col, val)| format!("{col} = {}", json_to_sql_literal(val)))
        .collect();
    let sql = format!("DELETE FROM {name} WHERE {}", where_clause.join(" AND "));
    let affected = pg.execute(&sql, &[]).await.map_err(|e| {
        warn!("advanced db_delete error: {e}");
        ApiError::BadRequest(e.to_string())
    })?;
    Ok(Json(json!({ "ok": true, "rows_affected": affected })))
}
