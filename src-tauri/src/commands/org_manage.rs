//! Org management commands — login, logout, set-default, rename alias, open
//! in browser, delete scratch org. All wrap `sf` subcommands via the shared
//! `cli::run_sf_json*` bridge; no new subprocess machinery.

use std::time::Duration;

use serde_json::Value;

use crate::cli::{run_sf_json, run_sf_json_with_timeout};
use crate::commands::orgs::{list_orgs, OrgEntry};
use crate::error::AppError;

/// `sf org login web` blocks on the user completing the browser auth flow —
/// give it much more room than the default 30s command timeout.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Opens the system browser for an interactive login, waits for it to
/// complete, then returns the freshly authenticated org's entry (looked up
/// from `list_orgs` by username, since `org login web`'s own JSON result
/// doesn't carry every field our `OrgEntry` needs).
#[tauri::command]
pub async fn org_login_web(
    alias: Option<String>,
    instance_url: Option<String>,
) -> Result<OrgEntry, AppError> {
    let mut args: Vec<&str> = vec!["org", "login", "web", "--json"];
    if let Some(a) = alias.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--alias");
        args.push(a);
    }
    if let Some(u) = instance_url.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--instance-url");
        args.push(u);
    }

    let result = run_sf_json_with_timeout(&args, Some(LOGIN_TIMEOUT)).await?;
    let username = result
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::CliError("org login web: no username in response".into()))?
        .to_string();

    list_orgs()
        .await?
        .into_iter()
        .find(|o| o.username == username)
        .ok_or_else(|| {
            AppError::CliError(format!(
                "logged in as {username}, but it didn't show up in `sf org list`"
            ))
        })
}

#[tauri::command]
pub async fn org_logout(username: String) -> Result<(), AppError> {
    run_sf_json(&["org", "logout", "-o", &username, "--no-prompt", "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn org_set_default(username: String) -> Result<(), AppError> {
    let arg = format!("target-org={username}");
    run_sf_json(&["config", "set", &arg, "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn org_set_alias(username: String, alias: String) -> Result<(), AppError> {
    let arg = format!("{alias}={username}");
    run_sf_json(&["alias", "set", &arg, "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn org_open(username: String) -> Result<(), AppError> {
    run_sf_json(&["org", "open", "-o", &username, "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn org_delete_scratch(username: String) -> Result<(), AppError> {
    run_sf_json(&[
        "org",
        "delete",
        "scratch",
        "-o",
        &username,
        "--no-prompt",
        "--json",
    ])
    .await?;
    Ok(())
}
