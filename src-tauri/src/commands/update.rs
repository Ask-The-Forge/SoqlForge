//! Record-update commands. Wraps `sf data update record`.
//!
//! The CLI's `--values` flag takes space-separated `Field=Value` pairs and
//! does its own light parsing. We pre-quote values that contain spaces or
//! special characters so multi-word strings round-trip cleanly.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::run_sf_json;
use crate::error::AppError;

/// Anything cmd.exe might treat as a `%VAR%` environment-variable expansion.
static POTENTIAL_ENV_EXPANSION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"%[^%]+%").expect("valid env-expansion regex"));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecordArgs {
    pub org_alias: String,
    pub object_name: String,
    pub record_id: String,
    /// `{ FieldApiName: scalar value }`. Booleans are serialized as
    /// "true"/"false"; null clears the field.
    pub values: HashMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecordResult {
    pub id: String,
    pub success: bool,
}

#[tauri::command]
pub async fn update_record(args: UpdateRecordArgs) -> Result<UpdateRecordResult, AppError> {
    if args.values.is_empty() {
        return Err(AppError::CliError("No values to update.".into()));
    }
    if args.record_id.trim().is_empty() {
        return Err(AppError::CliError("Record id is required.".into()));
    }

    // Build the --values string: `Field1=Value1 Field2="multi word"`.
    let values_str = encode_values(&args.values);

    // Newlines can't survive the cmd.exe hop to sf.cmd (the command line is
    // truncated at the first one, corrupting the update). The cell editors are
    // single-line so this shouldn't happen from the UI — hard-stop just in case.
    if values_str.contains('\n') || values_str.contains('\r') {
        return Err(AppError::CliError(
            "Multi-line values can't be saved through the CLI bridge — edit this field in Salesforce directly.".into(),
        ));
    }

    // cmd.exe expands `%VAR%` on the command line before sf runs and offers no
    // escape for it (CVE-2024-24576), so a value like "%path% due" would write
    // expanded garbage to the org. Unlike queries there is no file-based
    // alternative for `--values`, so refuse anything that cmd could expand.
    if POTENTIAL_ENV_EXPANSION.find(&values_str).is_some() {
        return Err(AppError::CliError(
            "Values containing a %...% pattern can't be saved safely through the CLI bridge — edit this field in Salesforce directly.".into(),
        ));
    }

    let cli_args: Vec<&str> = vec![
        "data",
        "update",
        "record",
        "-s",
        &args.object_name,
        "-i",
        &args.record_id,
        "-v",
        &values_str,
        "-o",
        &args.org_alias,
        "--json",
    ];

    let result = run_sf_json(&cli_args).await?;
    let id = result
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(&args.record_id)
        .to_string();
    let success = result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(UpdateRecordResult { id, success })
}

fn encode_values(values: &HashMap<String, Value>) -> String {
    let mut parts = Vec::with_capacity(values.len());
    for (k, v) in values {
        parts.push(format!("{}={}", k, encode_one(v)));
    }
    parts.join(" ")
}

fn encode_one(v: &Value) -> String {
    match v {
        Value::Null => "\"\"".into(),
        Value::Bool(b) => (if *b { "true" } else { "false" }).into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote_if_needed(s),
        other => quote_if_needed(&other.to_string()),
    }
}

/// `sf` splits the --values arg on whitespace, so anything containing a
/// space (and many special chars) must be wrapped in quotes. We use double
/// quotes and escape any internal quotes.
fn quote_if_needed(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".into();
    }
    if s.chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | ';' | '&' | '|'))
    {
        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("\"{}\"", escaped);
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quote_plain_unchanged() {
        assert_eq!(quote_if_needed("Acme"), "Acme");
    }

    #[test]
    fn quote_spaces_wrapped() {
        assert_eq!(quote_if_needed("Acme Inc"), "\"Acme Inc\"");
    }

    #[test]
    fn quote_internal_quote_escaped() {
        assert_eq!(quote_if_needed(r#"O"Brien"#), r#""O\"Brien""#);
    }

    #[test]
    fn env_expansion_guard_catches_var_patterns() {
        assert!(POTENTIAL_ENV_EXPANSION.find("%path%").is_some());
        assert!(POTENTIAL_ENV_EXPANSION
            .find("due %USERNAME% review")
            .is_some());
        // Lone or doubled percent signs can't expand — must stay allowed.
        assert!(POTENTIAL_ENV_EXPANSION.find("50% discount").is_none());
        assert!(POTENTIAL_ENV_EXPANSION.find("100%% sure").is_none());
        assert!(POTENTIAL_ENV_EXPANSION.find("plain value").is_none());
    }

    #[test]
    fn encode_one_types() {
        assert_eq!(encode_one(&json!(null)), "\"\"");
        assert_eq!(encode_one(&json!(true)), "true");
        assert_eq!(encode_one(&json!(false)), "false");
        assert_eq!(encode_one(&json!(42)), "42");
        assert_eq!(encode_one(&json!("Acme")), "Acme");
        assert_eq!(encode_one(&json!("with space")), "\"with space\"");
    }
}
