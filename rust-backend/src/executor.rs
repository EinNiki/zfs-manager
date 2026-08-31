use crate::error::ApiError;
use tokio::process::Command;
use tracing::debug;

const ALLOWED_ZFS: &[&str] = &[
    "list", "create", "destroy", "get", "set", "snapshot", "rollback", "clone",
    "rename", "mount", "unmount", "send", "recv", "diff", "upgrade", "allow",
    "unallow", "hold", "release", "inherit", "promote",
];

const ALLOWED_ZPOOL: &[&str] = &[
    "list", "status", "create", "destroy", "export", "import", "scrub", "history",
    "iostat", "upgrade", "online", "offline", "replace", "remove", "add", "split",
    "attach", "detach", "events", "labelclear", "get", "set",
];

fn validate_arg(arg: &str) -> Result<(), ApiError> {
    // Note: `{`/`}` are allowed — values like the JSON scrub schedule
    // (`zfsmanager:scrub_schedule={"enabled":true,...}`) must be passable, and
    // args are passed via Command (no shell), so braces are not dangerous.
    if arg.contains([';', '&', '|', '`', '$', '(', ')', '<', '>', '\n', '\r', '\0']) {
        return Err(ApiError::BadRequest("Invalid character in argument".into()));
    }
    if arg.contains("..") {
        return Err(ApiError::BadRequest("Path traversal not allowed".into()));
    }
    Ok(())
}

/// Run any `zfs` subcommand and return its stdout as a String.
pub async fn zfs(args: &[&str]) -> Result<String, ApiError> {
    if let Some(subcmd) = args.first() {
        if !ALLOWED_ZFS.contains(subcmd) {
            return Err(ApiError::BadRequest(format!("zfs subcommand '{}' is not allowed", subcmd)));
        }
    }
    for arg in args {
        validate_arg(arg)?;
    }
    command("zfs", args).await
}

/// Run any `zpool` subcommand and return its stdout as a String.
pub async fn zpool(args: &[&str]) -> Result<String, ApiError> {
    if let Some(subcmd) = args.first() {
        if !ALLOWED_ZPOOL.contains(subcmd) {
            return Err(ApiError::BadRequest(format!("zpool subcommand '{}' is not allowed", subcmd)));
        }
    }
    for arg in args {
        validate_arg(arg)?;
    }
    command("zpool", args).await
}

/// Run `zpool status <pool>` via host ZFS tools using nsenter so the output
/// includes version-specific fields (expand:, action:, etc.) that the older
/// container-side ZFS userland might omit. Falls back to container's zpool on error.
pub async fn zpool_status_host(pool: &str) -> Result<String, ApiError> {
    match command("nsenter", &["-t", "1", "-m", "--", "zpool", "status", pool]).await {
        Ok(out) => Ok(out),
        Err(_) => command("zpool", &["status", pool]).await,
    }
}

/// Run any `zpool` subcommand via the host's ZFS tools (nsenter into the host mount namespace).
/// This is required for features that the container's older zpool binary does not support
/// (e.g. feature@raidz_expansion). Falls back to container's zpool on nsenter failure.
pub async fn zpool_host(args: &[&str]) -> Result<String, ApiError> {
    for arg in args {
        validate_arg(arg)?;
    }
    let mut nsenter_args: Vec<&str> = vec!["-t", "1", "-m", "--", "zpool"];
    nsenter_args.extend_from_slice(args);
    match command("nsenter", &nsenter_args).await {
        Ok(out) => Ok(out),
        Err(_) => command("zpool", args).await,
    }
}

pub async fn command(bin: &str, args: &[&str]) -> Result<String, ApiError> {
    debug!("Executing: {} {:?}", bin, args);
    let output = Command::new(bin).args(args).output().await?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(ApiError::CommandFailed {
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            code: output.status.code(),
        })
    }
}


pub fn validate_zfs_name(name: &str, kind: &str) -> Result<(), ApiError> {
    if name.is_empty() {
        return Err(ApiError::BadRequest(format!("{kind} name cannot be empty")));
    }
    if name.len() > 256 {
        return Err(ApiError::BadRequest(format!("{kind} name too long")));
    }
    // ZFS names: alphanumeric, -, _, ., :, /, @
    if !name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '@')) {
        return Err(ApiError::BadRequest(format!("Invalid characters in {kind} name: {name}")));
    }
    Ok(())
}
