use std::{fs, path::Path};

use differens_narrate::OutputFormat;

/// Defaults loaded from the nearest `differens.toml` or `.differensrc.json`.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DifferensConfig {
    pub format: Option<OutputFormat>,
    pub driver_extensions: Option<Vec<String>>,
}

/// Load the nearest valid configuration; malformed files never stop diffing.
pub fn load_config(start_dir: impl AsRef<Path>) -> DifferensConfig {
    let start = start_dir.as_ref();
    for directory in start.ancestors() {
        for name in ["differens.toml", ".differensrc.json"] {
            let Ok(raw) = fs::read_to_string(directory.join(name)) else {
                continue;
            };
            let parsed = if name == ".differensrc.json" {
                serde_json::from_str::<serde_json::Value>(&raw).ok()
            } else {
                toml::from_str::<toml::Value>(&raw)
                    .ok()
                    .and_then(|value| serde_json::to_value(value).ok())
                    .or_else(|| legacy_toml(&raw))
            };
            if let Some(value) = parsed {
                let format = value
                    .get("format")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|format| format.parse().ok());
                let driver_extensions = value
                    .get("driverExtensions")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|values| {
                        values
                            .iter()
                            .map(|value| value.as_str().map(str::to_owned))
                            .collect()
                    });
                return DifferensConfig {
                    format,
                    driver_extensions,
                };
            }
        }
    }
    DifferensConfig::default()
}

// Preserve the old bootstrap format's unquoted strings/malformed-line tolerance.
// Fully valid TOML takes the standard parser path above, including escapes and
// comments inside string values.
fn legacy_toml(raw: &str) -> Option<serde_json::Value> {
    let mut object = serde_json::Map::new();
    for line in raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !matches!(key, "format" | "driverExtensions") {
            continue;
        }
        let value = value.trim();
        let parsed = if value.starts_with('"') || value.starts_with('[') {
            serde_json::from_str(value).ok()
        } else if !value.is_empty() {
            Some(serde_json::Value::String(value.to_owned()))
        } else {
            None
        };
        if let Some(value) = parsed {
            object.insert(key.to_owned(), value);
        }
    }
    (!object.is_empty()).then_some(serde_json::Value::Object(object))
}
