//! Record-delete commands. Wraps `sf data delete record` (one record per call)
//! and `sf data delete bulk` (a Bulk API 2.0 job for many at once).
//!
//! Deletion is destructive and irreversible from the app's point of view (the
//! record lands in the org's Recycle Bin at best), so the UI gates it behind an
//! explicit confirmation dialog and this layer validates its inputs strictly:
//! both the object name and the record ids must look like the identifiers they
//! are before we put them on a command line or in the upload file. That also
//! side-steps the cmd.exe `%VAR%` expansion hazard the update path has to
//! reject at runtime — a valid Salesforce id or API name can't contain a `%` in
//! the first place.

use std::collections::HashSet;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::{run_sf_json, run_sf_json_partial_ok};
use crate::error::AppError;

/// SObject API name: `Account`, `My_Object__c`, `ns__Thing__c`.
static OBJECT_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_]*$").expect("valid object-name regex"));

/// Salesforce record id — 15-char case-sensitive or 18-char case-safe form.
static RECORD_ID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$").expect("valid record-id regex"));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecordArgs {
    pub org_alias: String,
    pub object_name: String,
    pub record_id: String,
    /// Delete from a Tooling API object (ApexClass, TraceFlag, …). Mirrors the
    /// flag the result was queried with.
    #[serde(default)]
    pub use_tooling_api: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecordResult {
    pub id: String,
    pub success: bool,
}

#[tauri::command]
pub async fn delete_record(args: DeleteRecordArgs) -> Result<DeleteRecordResult, AppError> {
    let org_alias = args.org_alias.trim();
    let object_name = args.object_name.trim();
    let record_id = args.record_id.trim();

    if org_alias.is_empty() {
        return Err(AppError::CliError("No org selected.".into()));
    }
    if !OBJECT_NAME.is_match(object_name) {
        return Err(AppError::CliError(format!(
            "\"{object_name}\" isn't a valid object API name."
        )));
    }
    if !RECORD_ID.is_match(record_id) {
        return Err(AppError::CliError(format!(
            "\"{record_id}\" isn't a valid 15- or 18-character record id."
        )));
    }

    let mut cli_args: Vec<&str> = vec![
        "data",
        "delete",
        "record",
        "-s",
        object_name,
        "-i",
        record_id,
        "-o",
        org_alias,
        "--json",
    ];
    if args.use_tooling_api {
        cli_args.push("-t");
    }

    let result = run_sf_json(&cli_args).await?;
    let id = result
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(record_id)
        .to_string();
    // `sf data delete record` only returns a success envelope when it worked —
    // failures surface as a non-zero status the CLI bridge already turns into
    // an AppError — so a missing `success` key means "it went through".
    let success = result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(DeleteRecordResult { id, success })
}

/// Minutes `sf data delete bulk` waits on its job. Past that it returns the
/// job summary without per-record outcomes, and the job carries on in the org.
const BULK_DELETE_WAIT_MINUTES: u64 = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecordsBulkArgs {
    pub org_alias: String,
    pub object_name: String,
    pub record_ids: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeleteFailure {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeleteOutcomes {
    pub deleted: Vec<String>,
    pub failed: Vec<BulkDeleteFailure>,
    /// Never attempted — the job was aborted or failed before reaching them.
    pub unprocessed: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecordsBulkResult {
    pub job_id: Option<String>,
    /// Bulk job state: `JobComplete`, `InProgress` (the wait ran out),
    /// `Aborted`, … or `Unknown` when sf didn't report one.
    pub state: String,
    pub records_processed: Option<u64>,
    pub records_failed: Option<u64>,
    /// Per-record outcomes. None when sf didn't report them: the job was
    /// still running when the wait ran out, or the CLI predates them.
    pub results: Option<BulkDeleteOutcomes>,
}

/// Delete many records of one object in a single Bulk API 2.0 job. Standard
/// API objects only — the Bulk API has no Tooling counterpart, so Tooling
/// results go through `delete_record` one at a time.
#[tauri::command]
pub async fn delete_records_bulk(
    args: DeleteRecordsBulkArgs,
) -> Result<DeleteRecordsBulkResult, AppError> {
    let org_alias = args.org_alias.trim();
    let object_name = args.object_name.trim();

    if org_alias.is_empty() {
        return Err(AppError::CliError("No org selected.".into()));
    }
    if !OBJECT_NAME.is_match(object_name) {
        return Err(AppError::CliError(format!(
            "\"{object_name}\" isn't a valid object API name."
        )));
    }
    let mut seen = HashSet::with_capacity(args.record_ids.len());
    let mut ids: Vec<&str> = Vec::with_capacity(args.record_ids.len());
    for raw in &args.record_ids {
        let id = raw.trim();
        if !RECORD_ID.is_match(id) {
            return Err(AppError::CliError(format!(
                "\"{id}\" isn't a valid 15- or 18-character record id."
            )));
        }
        if seen.insert(id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Err(AppError::CliError("No records to delete.".into()));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = std::env::temp_dir().join(format!("soqlforge-delete-{stamp}.csv"));
    std::fs::write(&file, bulk_delete_csv(&ids))
        .map_err(|e| AppError::Io(format!("couldn't write the delete file: {e}")))?;
    let file_str = file.to_string_lossy().into_owned();
    let wait = BULK_DELETE_WAIT_MINUTES.to_string();

    let cli_args = [
        "data",
        "delete",
        "bulk",
        "-s",
        object_name,
        "-f",
        &file_str,
        "-o",
        org_alias,
        "-w",
        &wait,
        "--json",
    ];
    // The subprocess deadline covers the full wait plus time for sf to fetch
    // the per-record results once the job completes.
    let deadline = Duration::from_secs(BULK_DELETE_WAIT_MINUTES * 60 + 60);
    let result = run_sf_json_partial_ok(&cli_args, Some(deadline)).await;
    let _ = std::fs::remove_file(&file);
    Ok(parse_bulk_delete_result(&result?))
}

/// The upload file: an `Id` header, then one id per line. The line ending has
/// to be the platform's — sf declares CRLF to the Bulk API on Windows and LF
/// everywhere else, and a mismatch leaves a stray `\r` on every id.
fn bulk_delete_csv(ids: &[&str]) -> String {
    let eol = if cfg!(windows) { "\r\n" } else { "\n" };
    let mut out = String::from("Id");
    for id in ids {
        out.push_str(eol);
        out.push_str(id);
    }
    out.push_str(eol);
    out
}

/// Map `sf data delete bulk --json`'s result — `{ jobInfo, records: {
/// successfulResults, failedResults, unprocessedRecords } }`, rows keyed by
/// the Bulk API's CSV headers — onto the typed result.
fn parse_bulk_delete_result(result: &Value) -> DeleteRecordsBulkResult {
    let job = result.get("jobInfo");
    let job_str = |key: &str| {
        job.and_then(|j| j.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let job_u64 = |key: &str| job.and_then(|j| j.get(key)).and_then(Value::as_u64);

    // The row's own `Id` column is what we uploaded, so it matches the grid's
    // ids exactly; `sf__Id` is the fallback (and is empty on most failures).
    let row_id = |row: &Value| -> Option<String> {
        ["Id", "sf__Id"]
            .iter()
            .filter_map(|k| row.get(*k).and_then(Value::as_str))
            .find(|s| !s.is_empty())
            .map(str::to_string)
    };
    let rows = |key: &str| -> Vec<Value> {
        result
            .get("records")
            .and_then(|r| r.get(key))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };

    let results = result.get("records").map(|_| BulkDeleteOutcomes {
        deleted: rows("successfulResults")
            .iter()
            .filter_map(row_id)
            .collect(),
        failed: rows("failedResults")
            .iter()
            .filter_map(|row| {
                Some(BulkDeleteFailure {
                    id: row_id(row)?,
                    error: row
                        .get("sf__Error")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown error")
                        .to_string(),
                })
            })
            .collect(),
        unprocessed: rows("unprocessedRecords")
            .iter()
            .filter_map(row_id)
            .collect(),
    });

    DeleteRecordsBulkResult {
        job_id: job_str("id"),
        state: job_str("state").unwrap_or_else(|| "Unknown".into()),
        records_processed: job_u64("numberRecordsProcessed"),
        records_failed: job_u64("numberRecordsFailed"),
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_name_accepts_standard_and_custom() {
        assert!(OBJECT_NAME.is_match("Account"));
        assert!(OBJECT_NAME.is_match("My_Object__c"));
        assert!(OBJECT_NAME.is_match("ns__Thing__c"));
    }

    #[test]
    fn object_name_rejects_shell_bait() {
        assert!(!OBJECT_NAME.is_match(""));
        assert!(!OBJECT_NAME.is_match("Account Name"));
        assert!(!OBJECT_NAME.is_match("%USERNAME%"));
        assert!(!OBJECT_NAME.is_match("Account&calc"));
        assert!(!OBJECT_NAME.is_match("1Account"));
    }

    #[test]
    fn record_id_accepts_15_and_18_char_forms() {
        assert!(RECORD_ID.is_match("0018000000abcde"));
        assert!(RECORD_ID.is_match("0018000000abcdeAAB"));
    }

    #[test]
    fn record_id_rejects_wrong_length_or_punctuation() {
        assert!(!RECORD_ID.is_match(""));
        assert!(!RECORD_ID.is_match("0018000000abcd")); // 14
        assert!(!RECORD_ID.is_match("0018000000abcdeAA")); // 17
        assert!(!RECORD_ID.is_match("0018000000abcde AAB"));
        assert!(!RECORD_ID.is_match("0018000000abcde;rm"));
    }

    #[test]
    fn bulk_csv_is_an_id_header_then_one_id_per_line() {
        let csv = bulk_delete_csv(&["001000000000001AAA", "001000000000002AAA"]);
        let eol = if cfg!(windows) { "\r\n" } else { "\n" };
        assert_eq!(
            csv,
            format!("Id{eol}001000000000001AAA{eol}001000000000002AAA{eol}")
        );
    }

    /// Shape of `sf data delete bulk --json`'s `result` (plugin-data 3.x) for
    /// a job where one row failed.
    #[test]
    fn parses_per_record_outcomes() {
        let result = serde_json::json!({
            "jobInfo": {
                "id": "750000000000001AAA",
                "operation": "delete",
                "object": "Account",
                "state": "JobComplete",
                "numberRecordsProcessed": 3,
                "numberRecordsFailed": 1
            },
            "records": {
                "successfulResults": [
                    { "sf__Id": "001000000000001AAA", "sf__Created": "false", "Id": "001000000000001AAA" },
                    { "sf__Id": "001000000000002AAA", "sf__Created": "false", "Id": "001000000000002AAA" }
                ],
                "failedResults": [
                    { "sf__Id": "", "sf__Error": "ENTITY_IS_DELETED:entity is deleted:--", "Id": "001000000000003AAA" }
                ],
                "unprocessedRecords": []
            }
        });
        let parsed = parse_bulk_delete_result(&result);
        assert_eq!(parsed.job_id.as_deref(), Some("750000000000001AAA"));
        assert_eq!(parsed.state, "JobComplete");
        assert_eq!(parsed.records_processed, Some(3));
        assert_eq!(parsed.records_failed, Some(1));
        assert_eq!(
            parsed.results,
            Some(BulkDeleteOutcomes {
                deleted: vec!["001000000000001AAA".into(), "001000000000002AAA".into()],
                failed: vec![BulkDeleteFailure {
                    id: "001000000000003AAA".into(),
                    error: "ENTITY_IS_DELETED:entity is deleted:--".into(),
                }],
                unprocessed: vec![],
            })
        );
    }

    #[test]
    fn job_still_running_has_no_per_record_outcomes() {
        // The wait ran out: sf returns just the job summary.
        let result = serde_json::json!({
            "jobInfo": { "id": "750000000000001AAA", "state": "InProgress", "numberRecordsProcessed": 0 }
        });
        let parsed = parse_bulk_delete_result(&result);
        assert_eq!(parsed.state, "InProgress");
        assert_eq!(parsed.results, None);
    }

    #[test]
    fn unrecognized_result_degrades_to_unknown() {
        let parsed = parse_bulk_delete_result(&serde_json::json!([{ "id": "751" }]));
        assert_eq!(parsed.state, "Unknown");
        assert_eq!(parsed.job_id, None);
        assert_eq!(parsed.results, None);
    }
}
