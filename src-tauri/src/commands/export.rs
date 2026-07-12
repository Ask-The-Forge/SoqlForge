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
