//! Settings persistence — CLI options + AI provider config.
//!
//! Storage: `{app_data_dir}/settings.json` as a structured `AppSettings`:
//!   { "cli": { ... }, "ai": { ... } }
//! Old single-block CliSettings layouts still load via a fallback parse, so
//! upgrading the app won't blow away an existing path override.

use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::cli::{get_config, set_config, CliConfig};
use crate::error::AppError;

const SETTINGS_FILE: &str = "settings.json";

fn default_timeout_secs() -> u64 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSettings {
    pub path_override: Option<String>,
    /// Defaults to 30 (both for a missing JSON field and for
    /// `CliSettings::default()`) so a settings file written without a `cli`
    /// block doesn't collapse the timeout to the 5s clamp floor.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

impl Default for CliSettings {
    fn default() -> Self {
        Self {
            path_override: None,
            timeout_secs: default_timeout_secs(),
        }
    }
}

/// AI-provider configuration. All optional — if `provider` or `api_key` is
/// missing, the AI button in the UI just hints "configure in Settings".
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// "claude" | "gemini" | "openai" — case-insensitive on the server side.
    pub provider: Option<String>,
    pub api_key: Option<String>,
    /// Optional model name override; each provider has a sensible default.
    pub model: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub cli: CliSettings,
    #[serde(default)]
    pub ai: AiSettings,
}

// In-memory mirror so the AI command can read the key without re-parsing
// settings.json on every invocation. Synced via apply_ai/persist.
static AI_CACHE: Lazy<RwLock<AiSettings>> = Lazy::new(|| RwLock::new(AiSettings::default()));

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join(SETTINGS_FILE))
}

/// Called from `setup()` at app startup. Best-effort: missing file or parse
/// errors fall back to defaults silently.
pub fn load_persisted(app: &AppHandle) {
    let Some(path) = settings_path(app) else {
        return;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return;
    };

    // Try the nested AppSettings shape first; fall back to flat CliSettings
    // for files written by older versions of the app.
    let app_settings = serde_json::from_str::<AppSettings>(&contents).or_else(|_| {
        serde_json::from_str::<CliSettings>(&contents).map(|cli| AppSettings {
            cli,
            ai: AiSettings::default(),
        })
    });
    let Ok(s) = app_settings else { return };

    apply_cli(s.cli);
    apply_ai(s.ai);
}

fn apply_cli(settings: CliSettings) {
    let timeout_secs = settings.timeout_secs.clamp(5, 600);
    set_config(CliConfig {
        path_override: settings
            .path_override
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        timeout: Duration::from_secs(timeout_secs),
    });
}

fn apply_ai(settings: AiSettings) {
    *AI_CACHE.write().expect("AI_CACHE poisoned") = AiSettings {
        provider: settings
            .provider
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        api_key: settings
            .api_key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        model: settings
            .model
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
}

pub fn current_ai_settings() -> AiSettings {
    AI_CACHE.read().expect("AI_CACHE poisoned").clone()
}

fn persist(app: &AppHandle) -> Result<(), AppError> {
    let Some(path) = settings_path(app) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("create settings dir {parent:?}: {e}")))?;
    }

    let cfg = get_config();
    let cli = CliSettings {
        path_override: cfg.path_override,
        timeout_secs: cfg.timeout.as_secs(),
    };
    let ai = current_ai_settings();
    let combined = AppSettings { cli, ai };
    let json = serde_json::to_string_pretty(&combined)
        .map_err(|e| AppError::ParseError(format!("serialize settings: {e}")))?;
    std::fs::write(&path, json).map_err(|e| AppError::Io(format!("write {path:?}: {e}")))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI commands (kept async so they don't block the IPC thread).
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_cli_settings() -> CliSettings {
    let cfg = get_config();
    CliSettings {
        path_override: cfg.path_override,
        timeout_secs: cfg.timeout.as_secs(),
    }
}

#[tauri::command]
pub async fn set_cli_settings(
    app: AppHandle,
    settings: CliSettings,
) -> Result<CliSettings, AppError> {
    apply_cli(settings);
    persist(&app)?;
    Ok(get_cli_settings().await)
}

// ─────────────────────────────────────────────────────────────────────────────
// AI commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_ai_settings() -> AiSettings {
    current_ai_settings()
}

#[tauri::command]
pub async fn set_ai_settings(app: AppHandle, settings: AiSettings) -> Result<AiSettings, AppError> {
    apply_ai(settings);
    persist(&app)?;
    Ok(current_ai_settings())
}
