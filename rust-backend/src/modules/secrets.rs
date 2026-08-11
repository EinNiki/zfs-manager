use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use std::collections::HashMap;
use tracing::{info, warn};

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// Loads the AES-256 master key: `ZFS_SECRETS_MASTER_KEY` (base64, 32 bytes)
/// wins; otherwise a key is generated once and persisted in a writable data dir.
/// Tries multiple locations so it works in containers, VMs, and bare-metal.
pub fn load_master_key() -> Result<[u8; KEY_LEN], String> {
    if let Ok(b64) = std::env::var("ZFS_SECRETS_MASTER_KEY") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("ZFS_SECRETS_MASTER_KEY is not valid base64: {e}"))?;
        return bytes
            .try_into()
            .map_err(|_| "ZFS_SECRETS_MASTER_KEY must decode to exactly 32 bytes".to_string());
    }

    // Try a list of candidate paths — first one that works wins.
    let data_dir = crate::startup::data_dir();
    let candidates = [
        format!("{data_dir}/secrets.key"),
        "/var/lib/zfs-dashboard/secrets.key".to_string(),
        "/tmp/zfs-dashboard-secrets.key".to_string(),
    ];

    // Phase 1: try to read an existing key from any candidate path.
    for key_path in &candidates {
        if let Ok(bytes) = std::fs::read(key_path) {
            if bytes.len() == KEY_LEN {
                let key: [u8; KEY_LEN] = bytes
                    .try_into()
                    .map_err(|_| format!("{key_path} is corrupt (expected {KEY_LEN} bytes)"))?;
                info!("Secrets master key loaded from {key_path}");
                return Ok(key);
            }
            warn!("Secrets key at {key_path} is corrupt ({} bytes, expected {KEY_LEN}) — ignoring", bytes.len());
        }
    }

    // Phase 2: no existing key found — generate one and persist it to the
    // first writable location.
    let mut key = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key);

    let mut saved_to: Option<String> = None;
    for key_path in &candidates {
        // Ensure parent dir exists
        if let Some(parent) = std::path::Path::new(key_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match write_owner_only(key_path, &key) {
            Ok(()) => {
                saved_to = Some(key_path.clone());
                break;
            }
            Err(e) => {
                warn!("Cannot write secrets key to {key_path}: {e} — trying next location");
            }
        }
    }

    match &saved_to {
        Some(path) => {
            warn!("ZFS_SECRETS_MASTER_KEY not set — generated a new key at {path}. Set the env var for stable secret management across restarts.");
            Ok(key)
        }
        None => {
            // Last resort: use an in-memory key. Secrets won't survive a restart,
            // but at least saving config works instead of crashing with 500.
            warn!("Cannot persist secrets key anywhere — using an ephemeral in-memory key. Secrets will be lost on restart. Set ZFS_SECRETS_MASTER_KEY env var or fix filesystem permissions.");
            Ok(key)
        }
    }
}

/// Creates the file with owner-only permissions from the start — no window
/// where the key material is world-readable.
fn write_owner_only(path: &str, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(data)
}

/// Encrypts a secrets map to `nonce || ciphertext`.
pub fn encrypt_secrets(key: &[u8; KEY_LEN], secrets: &HashMap<String, String>) -> Result<Vec<u8>, String> {
    let plaintext = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_ref())
        .map_err(|_| "encryption failed".to_string())?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    Ok(out)
}

/// Decrypts a `nonce || ciphertext` blob back into the secrets map.
pub fn decrypt_secrets(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<HashMap<String, String>, String> {
    if blob.len() < NONCE_LEN {
        return Err("secrets blob too short".into());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let nonce: [u8; NONCE_LEN] = nonce_bytes.try_into().expect("length checked above");
    let plaintext = cipher
        .decrypt(&Nonce::from(nonce), ciphertext)
        .map_err(|_| "decryption failed (wrong master key?)".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
}

/// Startup self-check: round-trips a value so a broken key surfaces early.
pub fn verify_master_key(key: &[u8; KEY_LEN]) {
    let mut sample = HashMap::new();
    sample.insert("probe".to_string(), "ok".to_string());
    match encrypt_secrets(key, &sample).and_then(|blob| decrypt_secrets(key, &blob)) {
        Ok(round) if round.get("probe").map(String::as_str) == Some("ok") => {
            info!("Secrets master key loaded and verified");
        }
        _ => warn!("Secrets master key failed the encryption self-check"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [7u8; KEY_LEN];
        let mut secrets = HashMap::new();
        secrets.insert("api_key".to_string(), "s3cr3t".to_string());
        let blob = encrypt_secrets(&key, &secrets).unwrap();
        assert_eq!(decrypt_secrets(&key, &blob).unwrap(), secrets);
    }

    #[test]
    fn wrong_key_fails() {
        let blob = encrypt_secrets(&[1u8; KEY_LEN], &HashMap::new()).unwrap();
        assert!(decrypt_secrets(&[2u8; KEY_LEN], &blob).is_err());
    }

    #[test]
    fn tampered_blob_fails() {
        let mut blob = encrypt_secrets(&[1u8; KEY_LEN], &HashMap::new()).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert!(decrypt_secrets(&[1u8; KEY_LEN], &blob).is_err());
    }
}
