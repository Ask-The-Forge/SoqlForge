//! Core CLI bridge: spawns `sf` as an async subprocess, captures stdout,
//! strips ANSI escapes, and parses the `--json` envelope.
//!
//! Rules (from agents.md):
//! - Never hardcode CLI path; resolve from PATH with a settings override
//! - All subprocess calls async (tokio::process::Command)
//! - Stdout/stderr captured separately; stderr logged but not surfaced unless stdout empty
//! - Strip ANSI escape codes from output before JSON parse
//! - Query timeout default 30s, configurable

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

use crate::error::AppError;

/// Runtime-mutable CLI config (overrideable from the settings panel).
#[derive(Debug, Clone)]
pub struct CliConfig {
    /// Explicit path to `sf`. When `None`, we resolve from PATH.
    pub path_override: Option<String>,
    /// Subprocess timeout. Default 30s.
    pub timeout: Duration,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            path_override: None,
            timeout: Duration::from_secs(30),
        }
    }
}

static CONFIG: Lazy<RwLock<CliConfig>> = Lazy::new(|| RwLock::new(CliConfig::default()));

pub fn get_config() -> CliConfig {
    CONFIG.read().expect("config lock poisoned").clone()
}

pub fn set_config(cfg: CliConfig) {
    *CONFIG.write().expect("config lock poisoned") = cfg;
}

/// Resolve the `sf` executable: prefer override, then PATH.
fn resolve_sf() -> Result<String, AppError> {
    let cfg = get_config();
    if let Some(p) = cfg.path_override.as_ref().filter(|s| !s.is_empty()) {
        return Ok(p.clone());
    }
    // On Windows `sf` is typically `sf.cmd`; `which` handles PATHEXT.
    which::which("sf")
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| AppError::CliNotFound)
}

/// Quote a single command-line argument for safe consumption by a Windows
/// batch file. The result includes the surrounding quotes and is fed via
/// `Command::raw_arg` (which appends it verbatim to the command line).
///
/// Strategy:
///   - Always wrap in double quotes. Inside quotes, cmd.exe leaves the
///     "BatBadBut" metacharacters (`&|<>()^`) alone.
///   - Escape interior `"` as `""` per cmd convention. Trailing backslashes
///     before a quote are doubled per MSVCRT rules so the closing quote
///     isn't accidentally escaped.
///
/// Caveat: this does NOT (and cannot — see CVE-2024-24576) escape `%VAR%`
/// expansion or `!VAR!` (with delayed-expansion). cmd.exe expands `%VAR%`
/// even inside quotes, so callers must keep user text containing `%` off the
/// command line: queries with `%` route through a temp file
/// (`write_query_file`), and record updates reject `%...%` values outright.
fn quote_cmd_arg(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            // Flush pending backslashes (double them so they're literal),
            // then emit the escaped quote ("").
            for _ in 0..(backslashes * 2) {
                out.push('\\');
            }
            backslashes = 0;
            out.push('"');
            out.push('"');
            continue;
        }
        for _ in 0..backslashes {
            out.push('\\');
        }
        backslashes = 0;
        out.push(ch);
    }
    // Trailing backslashes need doubling so the closing quote isn't escaped.
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation registry
//
// Each run_soql invocation passes an opaque run-id; we track the spawned
// subprocess pid + a cancelled flag under that id so a `cancel_run` command
// can kill the whole process tree (sf.cmd → node) from another task.
// ─────────────────────────────────────────────────────────────────────────────

struct RunHandle {
    pid: Option<u32>,
    cancelled: Arc<AtomicBool>,
}

static RUNNING: Lazy<Mutex<HashMap<String, RunHandle>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Kill a process and all of its children. `sf` is a cmd shim that spawns
/// node, so killing just the direct child would leave the real work running.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn();
    }
}

/// Cancel a run by id. Returns true if the id was known (i.e. still running).
pub fn cancel(run_id: &str) -> bool {
    let map = RUNNING.lock().expect("RUNNING lock poisoned");
    if let Some(h) = map.get(run_id) {
        h.cancelled.store(true, Ordering::SeqCst);
        if let Some(pid) = h.pid {
            kill_tree(pid);
        }
        true
    } else {
        false
    }
}

/// Removes the registry entry when a run finishes (any exit path).
struct RunGuard(Option<String>);
impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Some(id) = self.0.take() {
            RUNNING.lock().expect("RUNNING lock poisoned").remove(&id);
        }
    }
}

/// Strip ANSI color/control escape sequences. `sf` occasionally emits them
/// even with `--json` (e.g. update-warning banners on stderr; we also defensively
/// strip stdout).
fn strip_ansi(s: &str) -> String {
    static RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]").expect("valid ansi regex"));
    RE.replace_all(s, "").into_owned()
}

/// Spawn `sf` with the given args, await with timeout, return parsed JSON `result` field
/// (or the full envelope if there is no `result`).
///
/// `sf`'s `--json` envelope is roughly:
///   success: `{ "status": 0, "result": {...} }`
///   failure: `{ "status": 1, "name": "...", "message": "...", "stack": "..." }`
pub async fn run_sf_json(args: &[&str]) -> Result<Value, AppError> {
    run_sf_json_cancellable(args, None, None).await
}

/// Variant that lets a caller override the default timeout. Use this for
/// operations that legitimately take longer than 30s — bulk queries, deploys,
/// etc.
pub async fn run_sf_json_with_timeout(
    args: &[&str],
    timeout_override: Option<Duration>,
) -> Result<Value, AppError> {
    run_sf_json_cancellable(args, timeout_override, None).await
}

/// Full-control variant: optional timeout override + optional run-id for
/// cancellation (see `cancel`).
pub async fn run_sf_json_cancellable(
    args: &[&str],
    timeout_override: Option<Duration>,
    run_id: Option<&str>,
) -> Result<Value, AppError> {
    let sf = resolve_sf()?;
    let cfg = get_config();
    let deadline = timeout_override.unwrap_or(cfg.timeout);

    let mut cmd = Command::new(&sf);

    // Rust 1.77+ hardened batch-file invocation (CVE-2024-24576) so `Command::arg`
    // refuses arguments containing characters like `(`, `)`, `!`, `=`, `'`, `"`,
    // `&`, `|`, `<`, `>`, `^`, `%`. Those are bread-and-butter SOQL, so for
    // .cmd/.bat targets we bypass the check via `raw_arg` and do our own
    // quoting. Inside double quotes, cmd.exe leaves the dangerous metachars
    // alone, and we escape interior `"` per cmd's `""` convention.
    #[cfg(windows)]
    {
        let lower = sf.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            for arg in args {
                cmd.raw_arg(quote_cmd_arg(arg));
            }
        } else {
            cmd.args(args);
        }
    }
    #[cfg(not(windows))]
    {
        cmd.args(args);
    }

    // On Windows, avoid flashing a console window when spawned from a GUI app.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("failed to spawn sf: {e}")))?;
    let pid = child.id();

    // Register for cancellation. The guard removes the entry on every exit
    // path; the flag tells us afterwards whether `cancel` fired (in which case
    // the process died because we killed it, not because sf failed).
    let cancelled_flag = Arc::new(AtomicBool::new(false));
    let _guard = if let Some(id) = run_id {
        RUNNING.lock().expect("RUNNING lock poisoned").insert(
            id.to_string(),
            RunHandle {
                pid,
                cancelled: cancelled_flag.clone(),
            },
        );
        RunGuard(Some(id.to_string()))
    } else {
        RunGuard(None)
    };

    let output = match timeout(deadline, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| AppError::Io(format!("failed to run sf: {e}")))?,
        Err(_) => {
            // Timed out — reap the subprocess tree so it doesn't keep running
            // (and holding the org connection) in the background.
            if let Some(pid) = pid {
                kill_tree(pid);
            }
            return Err(AppError::Timeout);
        }
    };

    if cancelled_flag.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));

    // sf emits the JSON envelope on stdout. Use stderr only if stdout is empty,
    // which happens for hard crashes (missing topic, syntax error in invocation).
    let payload = if stdout.trim().is_empty() {
        if stderr.trim().is_empty() {
            return Err(AppError::CliError(format!(
                "sf exited with no output (status: {:?})",
                output.status.code()
            )));
        }
        stderr.trim().to_string()
    } else {
        stdout.trim().to_string()
    };

    // Try to parse a JSON envelope. sf occasionally interleaves a single trailing
    // line with whitespace; we'll attempt the last non-empty line as a fallback.
    let parsed: Value = match serde_json::from_str(&payload) {
        Ok(v) => v,
        Err(_) => {
            // Some sf failures (auth-not-set, missing target-org) bypass the
            // --json wrapper and print plain text like "Error (Foo): message".
            // Promote those to a real error instead of a confusing parse error.
            if let Some(text_err) = extract_text_mode_sf_error(&payload) {
                return Err(text_err);
            }
            let last = payload
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("");
            serde_json::from_str(last).map_err(|e| {
                AppError::ParseError(format!(
                    "{e}; first 200 chars of output: {}",
                    payload.chars().take(200).collect::<String>()
                ))
            })?
        }
    };

    // Inspect envelope status / known error names.
    let status = parsed.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
    if status != 0 || parsed.get("name").is_some() {
        let name = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let message = parsed
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("(no message)")
            .to_string();

        return Err(classify_sf_error(&name, &message));
    }

    Ok(parsed
        .get("result")
        .cloned()
        .unwrap_or(Value::Object(Default::default())))
}

/// Scan plain-text sf output for an oclif/sf "Error (Name): message" line.
/// Returns a classified AppError if found; None otherwise.
///
/// Why: a handful of sf failures (no default org, update-required, certain
/// auth invalidations) happen too early in sf's lifecycle to honour --json,
/// so they go out as plain text on stdout, possibly mixed with an update-
/// available banner. Without this, the user would see a `[PARSE_ERROR]
/// expected value at line 1 column 1` wrapper around the actual message.
fn extract_text_mode_sf_error(payload: &str) -> Option<AppError> {
    static RE: Lazy<Regex> = Lazy::new(|| {
        // "Error (NoDefaultEnvError): No default environment found."
        Regex::new(r"(?m)^\s*Error\s*\(([^)]+)\)\s*:\s*(.+?)\s*$")
            .expect("valid sf text-error regex")
    });
    let cap = RE.captures(payload)?;
    let name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
    let message = cap.get(2).map(|m| m.as_str()).unwrap_or("");
    Some(classify_sf_error(name, message))
}

/// Map sf's error names to our `AppError` variants. Anything we don't recognise
/// falls through to `CliError`.
fn classify_sf_error(name: &str, message: &str) -> AppError {
    let n = name.to_ascii_lowercase();
    let m = message.to_ascii_lowercase();

    // Auth-related: sf raises these when the org is known but the refresh token
    // is invalid, or when the named alias has no auth entry at all.
    if n.contains("refreshtoken")
        || n.contains("nooauthtoken")
        || n.contains("namedorgnotfound")
        || n.contains("noauthinfo")
        || n.contains("nodefaultenv")
        || n.contains("notargetorg")
        || m.contains("expired access/refresh token")
        || m.contains("refresh token has expired")
        || m.contains("no authorization information")
        || m.contains("no default environment")
        || m.contains("--target-org")
    {
        return AppError::AuthExpired(message.to_string());
    }

    // SOQL parse / runtime errors come back as INVALID_*, MALFORMED_QUERY, etc.
    if n.starts_with("invalid_")
        || n == "malformed_query"
        || n.contains("queryerror")
        || m.contains("malformed_query")
        || m.contains("invalid soql")
    {
        return AppError::QueryError(message.to_string());
    }

    AppError::CliError(if name.is_empty() {
        message.to_string()
    } else {
        format!("{name}: {message}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_codes() {
        let input = "\x1b[31mError:\x1b[0m something \x1b[1;33mbroke\x1b[0m";
        assert_eq!(strip_ansi(input), "Error: something broke");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        let s = "no escape codes here\nnewlines too";
        assert_eq!(strip_ansi(s), s);
    }

    #[test]
    fn strip_ansi_handles_sf_update_banner() {
        // Real-world `sf` update notice glyph.
        let input = "\x1b[33m»   Warning: update available\x1b[0m\n{\"status\":0}";
        assert_eq!(
            strip_ansi(input),
            "»   Warning: update available\n{\"status\":0}"
        );
    }

    #[test]
    fn classify_auth_expired_from_name() {
        let e = classify_sf_error("RefreshTokenAuthError", "session expired");
        assert!(matches!(e, AppError::AuthExpired(_)), "got: {e:?}");
    }

    #[test]
    fn classify_auth_expired_from_message() {
        let e = classify_sf_error(
            "SomethingElse",
            "This org appears to have an expired access/refresh token.",
        );
        assert!(matches!(e, AppError::AuthExpired(_)), "got: {e:?}");
    }

    #[test]
    fn classify_named_org_not_found_as_auth() {
        let e = classify_sf_error("NamedOrgNotFoundError", "No org with alias foo");
        assert!(matches!(e, AppError::AuthExpired(_)), "got: {e:?}");
    }

    #[test]
    fn classify_invalid_field_as_query_error() {
        let e = classify_sf_error("INVALID_FIELD", "No such column 'Foo' on Account");
        assert!(matches!(e, AppError::QueryError(_)), "got: {e:?}");
    }

    #[test]
    fn classify_malformed_query() {
        let e = classify_sf_error("MALFORMED_QUERY", "unexpected token");
        assert!(matches!(e, AppError::QueryError(_)), "got: {e:?}");
    }

    #[test]
    fn classify_unknown_falls_through_to_cli_error() {
        let e = classify_sf_error("WeirdProvisioningError", "something else");
        match e {
            AppError::CliError(s) => assert!(s.contains("WeirdProvisioningError")),
            other => panic!("expected CliError, got {other:?}"),
        }
    }

    #[test]
    fn extracts_text_mode_no_default_env() {
        let payload = "»   Warning: @salesforce/cli update available from 2.111.7 to 2.137.7.\n\
                       Error (NoDefaultEnvError): No default environment found. \
                       Use -o or --target-org to specify an environment.";
        let err = extract_text_mode_sf_error(payload).expect("should extract");
        // Should classify as auth (target-org missing)
        assert!(matches!(err, AppError::AuthExpired(_)), "got: {err:?}");
    }

    #[test]
    fn extracts_text_mode_returns_none_on_clean_output() {
        assert!(extract_text_mode_sf_error("{\"status\":0,\"result\":{}}").is_none());
    }

    #[test]
    fn quote_cmd_arg_plain() {
        assert_eq!(quote_cmd_arg("hello"), "\"hello\"");
    }

    #[test]
    fn quote_cmd_arg_with_metacharacters() {
        // SOQL-shaped input — what the user's query has.
        let soql = "SELECT Id FROM Account WHERE Name = 'a & b' AND (X != null OR Y = 1)";
        let q = quote_cmd_arg(soql);
        // Must start/end with double quotes; original payload preserved inside.
        assert!(q.starts_with('"') && q.ends_with('"'));
        assert!(q.contains("SELECT Id FROM Account"));
        assert!(q.contains("a & b"));
        assert!(q.contains("(X != null OR Y = 1)"));
    }

    #[test]
    fn quote_cmd_arg_escapes_interior_quotes() {
        // Salesforce string literals are single-quoted, but defensively handle "
        let q = quote_cmd_arg(r#"say "hi""#);
        assert_eq!(q, r#""say ""hi""""#);
    }

    #[test]
    fn quote_cmd_arg_trailing_backslashes_doubled() {
        // Trailing `\` must be doubled so the closing `"` isn't escaped.
        let q = quote_cmd_arg(r"path\");
        assert_eq!(q, "\"path\\\\\"");
    }

    #[test]
    fn classify_empty_name_uses_just_message() {
        let e = classify_sf_error("", "bare message");
        match e {
            AppError::CliError(s) => assert_eq!(s, "bare message"),
            other => panic!("expected CliError, got {other:?}"),
        }
    }
}
