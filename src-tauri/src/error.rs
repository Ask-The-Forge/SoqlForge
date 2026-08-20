//! Unified error type returned from every Tauri command.
//!
//! Serialized to the frontend as `{ code, message, detail? }` so the
//! React layer can branch on `code` and render contextual UI.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    /// `sf` is not on PATH and no override was configured.
    #[error("Salesforce CLI not found on PATH")]
    CliNotFound,

    /// The org alias is known to `sf`, but its session/refresh token is invalid.
    #[error("authentication expired for org: {0}")]
    AuthExpired(String),

    /// SOQL parse error or runtime error reported by Salesforce.
    #[error("query error: {0}")]
    QueryError(String),

    /// Subprocess exceeded its deadline — the configurable CLI timeout for
    /// administrative calls (default 30s), or the fixed 10-minute allowance
    /// for query runs.
    #[error("timed out waiting for the Salesforce CLI")]
    Timeout,

    /// The user cancelled the run (we killed the subprocess tree).
    #[error("query cancelled")]
    Cancelled,

    /// `sf` exited non-zero with a structured error that didn't match the other
    /// categories — message is the `message` field from sf's JSON envelope, or
    /// stderr if no JSON came back.
    #[error("CLI error: {0}")]
    CliError(String),

    /// `sf` returned output that wasn't JSON despite `--json`.
    #[error("failed to parse CLI output: {0}")]
    ParseError(String),

    /// IO / spawn failures.
    #[error("IO error: {0}")]
    Io(String),
}

impl AppError {
    /// Stable machine-readable code, used by the frontend to switch on error kind.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::CliNotFound => "CLI_NOT_FOUND",
            AppError::AuthExpired(_) => "AUTH_EXPIRED",
            AppError::QueryError(_) => "QUERY_ERROR",
            AppError::Timeout => "TIMEOUT",
            AppError::Cancelled => "CANCELLED",
            AppError::CliError(_) => "CLI_ERROR",
            AppError::ParseError(_) => "PARSE_ERROR",
            AppError::Io(_) => "IO_ERROR",
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

/// Custom serialization: emit `{ code, message }` instead of the default
/// enum-shaped JSON so the TypeScript side has one stable shape.
impl Serialize for AppError {
    fn serialize<S>(&self, ser: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = ser.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}
