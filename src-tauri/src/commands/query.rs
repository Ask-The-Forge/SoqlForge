//! SOQL query commands. Wraps `sf data query`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::run_sf_json_cancellable;
use crate::error::AppError;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryOptions {
    /// Hit the Tooling API instead of the standard SOQL endpoint. Required for
    /// metadata-backed objects (ApexClass, CustomField, etc.).
    pub use_tooling_api: bool,
    /// Run via the Bulk API (`--bulk`). Strongly recommended for queries that
    /// return more than ~2000 records; required for anything north of 50k.
    /// We always pair `--bulk` with `--wait`, so the call is synchronous.
    pub use_bulk_api: bool,
    /// Include soft-deleted / archived records (`--all-rows` flag — uses
    /// `queryAll` instead of `query`).
    pub all_rows: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub total_size: u64,
    pub done: bool,
    pub records: Vec<Value>,
    pub columns: Vec<String>,
    pub elapsed_ms: u64,
}

/// How long we're willing to wait for a bulk query to complete before timing
/// out the subprocess. Aligned with the `--wait` flag we pass below so the CLI
/// and our timeout don't disagree. 10 minutes covers the vast majority of
/// real-world queries; users can re-run via the CLI directly for anything
/// larger.
const BULK_WAIT_MINUTES: u32 = 10;

#[tauri::command]
pub async fn run_soql(
    org_alias: String,
    query: String,
    options: Option<QueryOptions>,
    run_id: Option<String>,
) -> Result<QueryResult, AppError> {
    let opts = options.unwrap_or_default();
    let start = std::time::Instant::now();

    // Catch the common "no org selected in the UI" case BEFORE shelling out
    // to sf — otherwise the user sees a confusing PARSE_ERROR wrapped around
    // sf's "NoDefaultEnvError" plain-text complaint.
    let org_alias = org_alias.trim().to_string();
    if org_alias.is_empty() {
        return Err(AppError::QueryError(
            "Select an org from the dropdown at the top before running a query.".to_string(),
        ));
    }
    let query_trimmed = query.trim();
    if query_trimmed.is_empty() {
        return Err(AppError::QueryError(
            "Empty query — type a SOQL statement in the editor first.".to_string(),
        ));
    }

    // Bulk goes through `sf data export bulk` — modern sf CLI removed the
    // `--bulk` flag from `sf data query` entirely ("Nonexistent flags" error).
    if opts.use_bulk_api {
        if opts.use_tooling_api {
            return Err(AppError::QueryError(
                "The Bulk API can't be combined with the Tooling API — uncheck one.".to_string(),
            ));
        }
        return run_soql_bulk(&org_alias, query_trimmed, &opts, run_id.as_deref(), start).await;
    }

    // Multi-line queries can't go through `-q`: on Windows, args reach sf.cmd
    // via cmd.exe, and an embedded newline TRUNCATES the command line there —
    // everything after it (including `-o` and `--json`) is silently dropped,
    // and sf then fails with a misleading NoDefaultEnvError. Route those
    // through a temp file + `-f` instead, which sf supports natively.
    let query_file = write_query_file(query_trimmed)?;
    let query_file_str = query_file
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());

    let mut args: Vec<&str> = vec!["data", "query"];
    match query_file_str.as_deref() {
        Some(f) => {
            args.push("-f");
            args.push(f);
        }
        None => {
            args.push("-q");
            args.push(query_trimmed);
        }
    }
    args.extend_from_slice(&["-o", &org_alias, "--json"]);
    if opts.use_tooling_api {
        args.push("--use-tooling-api");
    }
    if opts.all_rows {
        args.push("--all-rows");
    }

    let result = run_sf_json_cancellable(&args, None, run_id.as_deref()).await;
    if let Some(p) = &query_file {
        let _ = std::fs::remove_file(p);
    }
    let result = result?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    let total_size = result.get("totalSize").and_then(Value::as_u64).unwrap_or(0);
    let done = result.get("done").and_then(Value::as_bool).unwrap_or(true);

    let records: Vec<Value> = result
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let columns = derive_columns(&records);

    Ok(QueryResult {
        total_size,
        done,
        records,
        columns,
        elapsed_ms,
    })
}

/// When the query contains newlines or `%`, persist it to a temp file so it
/// can be passed via `-f`/`--query-file`. Returns None for other single-line
/// queries (the common case — those go through `-q` with no file I/O).
///
/// Why `%`: sf is a cmd shim, and cmd.exe expands `%VAR%` on the command line
/// before sf ever runs — there is no way to escape it there (see
/// CVE-2024-24576). `LIKE '%os%'` would silently become `LIKE 'Windows_NT'`.
/// The file path sidesteps cmd entirely.
fn write_query_file(query: &str) -> Result<Option<std::path::PathBuf>, AppError> {
    if !query.contains('\n') && !query.contains('\r') && !query.contains('%') {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("soqlforge-query-{stamp}.soql"));
    std::fs::write(&path, query)
        .map_err(|e| AppError::Io(format!("write query temp file: {e}")))?;
    Ok(Some(path))
}

fn derive_columns(records: &[Value]) -> Vec<String> {
    records
        .first()
        .and_then(|r| r.as_object())
        .map(|m| {
            m.keys()
                .filter(|k| k.as_str() != "attributes")
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Bulk path: `sf data export bulk -q <soql> --output-file <tmp> -r json`.
/// The records land in a temp file (a plain JSON array, no attributes
/// envelopes); the --json envelope on stdout carries `{ totalSize, filePath }`.
async fn run_soql_bulk(
    org_alias: &str,
    query: &str,
    opts: &QueryOptions,
    run_id: Option<&str>,
    start: std::time::Instant,
) -> Result<QueryResult, AppError> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("soqlforge-bulk-{stamp}.json"));
    let tmp_str = tmp.to_string_lossy().into_owned();
    let wait_str = BULK_WAIT_MINUTES.to_string();

    // Same newline-vs-cmd.exe issue as the REST path — see write_query_file.
    let query_file = write_query_file(query)?;
    let query_file_str = query_file
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());

    let mut args: Vec<&str> = vec!["data", "export", "bulk"];
    match query_file_str.as_deref() {
        Some(f) => {
            args.push("--query-file");
            args.push(f);
        }
        None => {
            args.push("-q");
            args.push(query);
        }
    }
    args.extend_from_slice(&[
        "-o",
        org_alias,
        "--output-file",
        &tmp_str,
        "-r",
        "json",
        "-w",
        &wait_str,
        "--json",
    ]);
    if opts.all_rows {
        args.push("--all-rows");
    }

    // Subprocess timeout matches the --wait minutes plus a small buffer for
    // sf to return after the job completes.
    let call_timeout = Some(Duration::from_secs((BULK_WAIT_MINUTES as u64 * 60) + 30));

    let run_result = run_sf_json_cancellable(&args, call_timeout, run_id).await;
    if let Some(p) = &query_file {
        let _ = std::fs::remove_file(p);
    }
    let envelope = match run_result {
        Ok(v) => v,
        Err(e) => {
            // Cancelled / timed out / failed — don't leave a partial temp file.
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };

    let total_size = envelope
        .get("totalSize")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let contents = tokio::fs::read_to_string(&tmp).await.ok();
    let _ = std::fs::remove_file(&tmp);

    let records: Vec<Value> = contents
        .as_deref()
        .and_then(|c| serde_json::from_str(c).ok())
        .unwrap_or_default();
    let columns = derive_columns(&records);

    Ok(QueryResult {
        total_size: total_size.max(records.len() as u64),
        done: true,
        records,
        columns,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

/// Cancel an in-flight `run_soql` by the run-id the frontend generated for it.
/// Kills the whole `sf` process tree; the pending run_soql then resolves with
/// a CANCELLED error. Returns whether the id was still running.
#[tauri::command]
pub async fn cancel_run(run_id: String) -> Result<bool, AppError> {
    Ok(crate::cli::cancel(&run_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_single_line_query_stays_on_command_line() {
        assert!(write_query_file("SELECT Id FROM Account")
            .unwrap()
            .is_none());
    }

    #[test]
    fn percent_query_routes_through_temp_file() {
        // cmd.exe would expand %os% before sf runs — must go via --query-file.
        let path = write_query_file("SELECT Id FROM Account WHERE Name LIKE '%os%'")
            .unwrap()
            .expect("query with % must use a temp file");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "SELECT Id FROM Account WHERE Name LIKE '%os%'"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn multiline_query_routes_through_temp_file() {
        let path = write_query_file("SELECT Id\nFROM Account")
            .unwrap()
            .expect("multi-line query must use a temp file");
        let _ = std::fs::remove_file(path);
    }
}
