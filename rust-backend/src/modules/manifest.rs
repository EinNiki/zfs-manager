use serde::{Deserialize, Serialize};

/// Hard limit for a module.toml file (64 KiB) — anything bigger is suspicious.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Hard limit for a .wasm artifact (32 MiB).
pub const MAX_WASM_BYTES: usize = 32 * 1024 * 1024;

/// Parsed `module.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub repository_url: String,
    /// File name of the Wasm component inside the module package.
    pub wasm_entrypoint: String,
    #[serde(default)]
    pub permissions: Permissions,
    /// Field definitions the frontend renders as a config form.
    #[serde(default)]
    pub config_schema: Vec<ConfigField>,
    /// Widget definitions the frontend renders as module dashboard widgets.
    #[serde(default)]
    pub widget_schema: Vec<WidgetDefinition>,
    /// Status fields for dynamic display in Active Modules UI.
    #[serde(default)]
    pub status_fields: Vec<StatusField>,
    /// Action buttons for execution in Active Modules UI.
    #[serde(default)]
    pub actions: Vec<ModuleAction>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Permissions {
    /// Static domain allowlist ("api.example.com" or "host:port").
    /// Hosts taken from config fields of type `url` are allowed additionally.
    #[serde(default)]
    pub network_allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    pub key: String,
    pub label: String,
    /// text | url | secret | number | select | multiselect | schedule
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    /// Options for select/multiselect fields.
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetDefinition {
    pub key: String,
    pub label: String,
    /// stat | line | bar | gauge | table
    #[serde(rename = "type")]
    pub widget_type: String,
    /// Which metric names this widget displays
    pub metrics: Vec<String>,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub metric: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleAction {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
}

const ALLOWED_FIELD_TYPES: &[&str] = &[
    "text", "textarea", "string", "url", "secret", "number", "select", "multiselect", "schedule",
];

const ALLOWED_WIDGET_TYPES: &[&str] = &[
    "stat", "line", "bar", "gauge", "table",
];

impl Manifest {
    pub fn parse(toml_text: &str) -> Result<Self, String> {
        if toml_text.len() > MAX_MANIFEST_BYTES {
            return Err(format!("manifest exceeds {MAX_MANIFEST_BYTES} bytes"));
        }
        let manifest: Manifest =
            toml::from_str(toml_text).map_err(|e| format!("invalid module.toml: {e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err("module id must be 1-64 chars of [a-z0-9-_]".into());
        }
        if self.name.is_empty() || self.name.len() > 128 {
            return Err("module name must be 1-128 chars".into());
        }
        if self.version.len() > 32 {
            return Err("module version must be 0-32 chars".into());
        }
        if self.wasm_entrypoint.is_empty()
            || self.wasm_entrypoint.contains('/')
            || self.wasm_entrypoint.contains("..")
            || !self.wasm_entrypoint.ends_with(".wasm")
        {
            return Err("wasm_entrypoint must be a plain .wasm file name".into());
        }
        for domain in &self.permissions.network_allowlist {
            if domain.is_empty() || domain.len() > 253 || domain.contains('/') || domain.contains(' ') {
                return Err(format!("invalid allowlist entry: {domain:?}"));
            }
        }
        for field in &self.config_schema {
            if field.key.is_empty()
                || field.key.len() > 64
                || !field.key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Err(format!("invalid config field key: {:?}", field.key));
            }
            if !ALLOWED_FIELD_TYPES.contains(&field.field_type.as_str()) {
                return Err(format!(
                    "config field {:?} has unknown type {:?}",
                    field.key, field.field_type
                ));
            }
            if matches!(field.field_type.as_str(), "select" | "multiselect") && field.options.is_empty() {
                return Err(format!("config field {:?} needs options", field.key));
            }
        }
        for widget in &self.widget_schema {
            if widget.key.is_empty()
                || widget.key.len() > 64
                || !widget.key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Err(format!("invalid widget key: {:?}", widget.key));
            }
            if !ALLOWED_WIDGET_TYPES.contains(&widget.widget_type.as_str()) {
                return Err(format!(
                    "widget {:?} has unknown type {:?}",
                    widget.key, widget.widget_type
                ));
            }
            if widget.metrics.is_empty() {
                return Err(format!("widget {:?} must reference at least one metric", widget.key));
            }
        }
        Ok(())
    }

    /// Keys of all secret-typed config fields.
    pub fn secret_keys(&self) -> Vec<&str> {
        self.config_schema
            .iter()
            .filter(|f| f.field_type == "secret")
            .map(|f| f.key.as_str())
            .collect()
    }

    /// Keys of all url-typed config fields (their hosts extend the allowlist).
    pub fn url_keys(&self) -> Vec<&str> {
        self.config_schema
            .iter()
            .filter(|f| f.field_type == "url")
            .map(|f| f.key.as_str())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"
        id = "immich"
        name = "Immich Stats"
        version = "1.0.0"
        wasm_entrypoint = "immich.wasm"

        [permissions]
        network_allowlist = []

        [[config_schema]]
        key = "immich_url"
        label = "Immich URL"
        type = "url"
        required = true

        [[config_schema]]
        key = "immich_api_key"
        label = "API Key"
        type = "secret"
        required = true
    "#;

    #[test]
    fn parses_valid_manifest() {
        let m = Manifest::parse(VALID).expect("should parse");
        assert_eq!(m.id, "immich");
        assert_eq!(m.secret_keys(), vec!["immich_api_key"]);
        assert_eq!(m.url_keys(), vec!["immich_url"]);
    }

    #[test]
    fn rejects_bad_id() {
        let bad = VALID.replace("id = \"immich\"", "id = \"IM MICH!\"");
        assert!(Manifest::parse(&bad).is_err());
    }

    #[test]
    fn rejects_path_traversal_entrypoint() {
        let bad = VALID.replace("immich.wasm", "../evil.wasm");
        assert!(Manifest::parse(&bad).is_err());
    }

    #[test]
    fn rejects_unknown_field_type() {
        let bad = VALID.replace("type = \"url\"", "type = \"file\"");
        assert!(Manifest::parse(&bad).is_err());
    }
}
