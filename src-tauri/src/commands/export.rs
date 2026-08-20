//! File-export commands. Browser `<a download>` doesn't work in WebView2 (no
//! download manager), so we route saves through Tauri's dialog plugin + std::fs.
//!
//! Exports are STREAMED: `save_csv_begin` shows the dialog and writes the
//! first chunk, `save_csv_append` adds subsequent chunks, `save_csv_finish` /
//! `save_csv_discard` close the stream (keeping or deleting the file). A
//! single-shot command that took the whole CSV as one argument OOM'd the
//! WebView on six-figure row counts — the entire file existed as one JS
//! string AND again inside the serialized IPC message.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;

/// Most exports allowed to sit open at once, oldest evicted first.
///
/// A webview reload (or a renderer crash) between `begin` and `finish`
/// orphans an entry that nothing will ever close, so an unbounded collection
/// would grow for the life of the process. The UI disables the Export button
/// while one export is in flight, so a handful of slots is already far beyond
/// the real concurrency.
const MAX_OPEN_EXPORTS: usize = 8;

/// Paths handed out by `save_csv_begin` that haven't been finished or
/// discarded yet, oldest first. `append`/`discard` refuse paths that aren't in
/// here, so the only files the frontend can ever grow or delete are ones the
/// user just picked in the native save dialog. A `Vec` rather than a set:
/// insertion order is what makes eviction well-defined, and `MAX_OPEN_EXPORTS`
/// keeps the linear scans trivial.
static OPEN_EXPORTS: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn open_exports() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    OPEN_EXPORTS.lock().expect("OPEN_EXPORTS poisoned")
}

/// Register a freshly-created export, evicting the oldest when full.
fn register_export(path: PathBuf) {
    let mut open = open_exports();
    open.retain(|p| p != &path);
    if open.len() >= MAX_OPEN_EXPORTS {
        open.remove(0);
    }
    open.push(path);
}

/// Forget an export. Returns whether it was actually open — `discard` keys the
/// file deletion off that, so a stale path never deletes anything.
fn unregister_export(path: &PathBuf) -> bool {
    let mut open = open_exports();
    let before = open.len();
    open.retain(|p| p != path);
    open.len() != before
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// Absolute path that was written; `None` if the user cancelled the dialog.
    pub path: Option<String>,
}

/// Show the native save-file dialog and write `content` (the BOM + header +
/// first rows) to the chosen path, truncating any existing file. The path
/// stays registered as an open export until `finish`/`discard`.
#[tauri::command]
pub async fn save_csv_begin(
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
    register_export(pb.clone());

    Ok(SaveResult {
        path: Some(pb.to_string_lossy().into_owned()),
    })
}

/// Append a chunk to an export started by `save_csv_begin`.
#[tauri::command]
pub async fn save_csv_append(path: String, content: String) -> Result<(), AppError> {
    let pb = PathBuf::from(&path);
    if !open_exports().contains(&pb) {
        return Err(AppError::Io(format!("not an open export: {path}")));
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&pb)
        .map_err(|e| AppError::Io(format!("open {pb:?} for append: {e}")))?;
    file.write_all(content.as_bytes())
        .map_err(|e| AppError::Io(format!("append to {pb:?}: {e}")))
}

/// Close out a completed export — the file stays, the path just stops being
/// appendable.
#[tauri::command]
pub async fn save_csv_finish(path: String) -> Result<(), AppError> {
    unregister_export(&PathBuf::from(path));
    Ok(())
}

/// Abort an in-flight export and delete the partial file — a half-written CSV
/// that LOOKS complete is worse than no file.
#[tauri::command]
pub async fn save_csv_discard(path: String) -> Result<(), AppError> {
    let pb = PathBuf::from(&path);
    if unregister_export(&pb) {
        let _ = std::fs::remove_file(&pb);
    }
    Ok(())
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
/// check, and the only paths that reach it are ones `save_csv_begin` just
/// wrote.
#[tauri::command]
pub async fn open_saved_file(path: String) -> Result<(), AppError> {
    // The free function (unlike `Opener::open_path`) stats the path first, so a
    // file that has since been moved or deleted reports that plainly instead of
    // failing somewhere inside the OS handler.
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| AppError::Io(format!("open {path}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, not several: `OPEN_EXPORTS` is process-global, so separate
    /// `#[test]` fns would race each other under the default parallel runner.
    #[test]
    fn open_exports_registry_evicts_oldest_and_reports_removal() {
        let path = |n: usize| PathBuf::from(format!("/tmp/soqlforge-test-{n}.csv"));

        // A registered path is appendable; an unregistered one never is.
        register_export(path(0));
        assert!(open_exports().contains(&path(0)));
        assert!(!open_exports().contains(&path(99)));

        // Re-registering the same path doesn't double-count it.
        register_export(path(0));
        assert_eq!(open_exports().iter().filter(|p| *p == &path(0)).count(), 1);

        // Filling past the cap evicts oldest-first and stays bounded — this is
        // what keeps a webview reload between begin and finish from leaking an
        // entry for the life of the process.
        for n in 1..=MAX_OPEN_EXPORTS {
            register_export(path(n));
        }
        assert_eq!(open_exports().len(), MAX_OPEN_EXPORTS);
        assert!(
            !open_exports().contains(&path(0)),
            "oldest should be evicted"
        );
        assert!(open_exports().contains(&path(MAX_OPEN_EXPORTS)));

        // unregister reports whether it actually removed something — discard
        // keys file deletion off that, so a stale path must report false.
        assert!(unregister_export(&path(MAX_OPEN_EXPORTS)));
        assert!(!unregister_export(&path(MAX_OPEN_EXPORTS)));
        assert!(!unregister_export(&path(0)));

        open_exports().clear();
    }
}
