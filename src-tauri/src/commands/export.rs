//! File-export commands. Browser `<a download>` doesn't work in WebView2 (no
//! download manager), so we route saves through Tauri's dialog plugin + std::fs.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// Absolute path that was written; `None` if the user cancelled the dialog.
    pub path: Option<String>,
}

#[tauri::command]
pub async fn save_csv(
    app: AppHandle,
    content: String,
    default_filename: String,
) -> Result<SaveResult, AppError> {
    // Show the native save-file dialog. Use the blocking variant inside a tokio
    // blocking task so we don't lock up the main thread.
    let dialog = app.dialog().clone();
    let picked = tokio::task::spawn_blocking(move || {
        dialog
            .file()
            .add_filter("CSV", &["csv"])
            .set_file_name(default_filename)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Io(format!("dialog task join: {e}")))?;

    let Some(file_path) = picked else {
        return Ok(SaveResult { path: None });
    };

    // tauri_plugin_dialog::FilePath → PathBuf
    let pb = file_path
        .into_path()
        .map_err(|e| AppError::Io(format!("invalid save path: {e}")))?;
    std::fs::write(&pb, content).map_err(|e| AppError::Io(format!("write {pb:?}: {e}")))?;

    Ok(SaveResult {
        path: Some(pb.to_string_lossy().into_owned()),
    })
}

/// Open a file we just saved in the OS default application.
///
/// Deliberately NOT the opener plugin's JS `openPath()`. That call goes through
/// the plugin's IPC command, which validates the path against the plugin's
/// scope — and `opener:allow-open-path` grants the command, in its own words,
/// "without any pre-configured scope". With no path entries in the scope,
/// `is_path_allowed` is always false and every call failed with
/// `ForbiddenPath`, so the Export CSV "Open" button did nothing at all.
/// (`openUrl` is unaffected: `opener:default` pulls in `allow-default-urls`,
/// which DOES ship `http://*` / `https://*` scope entries — which is why the
/// "Object Setup" and per-row record links work.)
///
/// Granting a path scope instead isn't practical: the path is whatever the user
/// picked in the native save dialog, so it can live on any volume, and the glob
/// would have to be written per-platform. The Rust-side API carries no scope
/// check, and the only paths that reach it are ones `save_csv` just wrote.
#[tauri::command]
pub async fn open_saved_file(path: String) -> Result<(), AppError> {
    // The free function (unlike `Opener::open_path`) stats the path first, so a
    // file that has since been moved or deleted reports that plainly instead of
    // failing somewhere inside the OS handler.
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| AppError::Io(format!("open {path}: {e}")))
}
