//! Record-delete commands. Wraps `sf data delete record`.
//!
//! Deletion is destructive and irreversible from the app's point of view (the
//! record lands in the org's Recycle Bin at best), so the UI gates it behind an
//! explicit confirmation dialog and this layer validates its inputs strictly:
//! both the object name and the record id must look like the identifiers they
//! are before we put them on a command line. That also side-steps the cmd.exe
//! `%VAR%` expansion hazard the update path has to reject at runtime — a valid
//! Salesforce id or API name can't contain a `%` in the first place.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::run_sf_json;
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
}
