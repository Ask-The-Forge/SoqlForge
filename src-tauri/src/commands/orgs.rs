//! Org listing commands. Wraps `sf org list --json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::run_sf_json;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgEntry {
    pub alias: String,
    pub username: String,
    pub instance_url: String,
    pub is_default: bool,
    /// "Connected" | "RefreshTokenError" | "Unknown"
    pub connected_status: String,
    /// "Scratch" | "Sandbox" | "DevHub" | "Other" — derived from which
    /// `sf org list` bucket the entry came from.
    pub org_type: String,
    /// Scratch orgs only — ISO date (YYYY-MM-DD) the org expires.
    pub expiration_date: Option<String>,
    /// Scratch orgs only — the DevHub username that created it.
    pub dev_hub_username: Option<String>,
}

/// Maps an `sf org list --json` bucket key to our `org_type` label.
fn org_type_for_bucket(key: &str) -> &'static str {
    match key {
        "scratchOrgs" => "Scratch",
        "sandboxes" => "Sandbox",
        "devHubs" => "DevHub",
        _ => "Other",
    }
}

#[tauri::command]
pub async fn list_orgs() -> Result<Vec<OrgEntry>, AppError> {
    // sf org list --json returns: { nonScratchOrgs: [...], scratchOrgs: [...], devHubs: [...], sandboxes: [...] }
    // Each entry has: alias, username, instanceUrl, isDefaultUsername / isDefaultDevHubUsername,
    // connectedStatus, etc. Scratch orgs additionally carry expirationDate + devHubUsername.
    let result = run_sf_json(&["org", "list", "--json"]).await?;

    let mut out: Vec<OrgEntry> = Vec::new();
    // Collect every category, dedup by username (the stable identifier).
    // Specific buckets (scratch/devhub/sandbox) must come before the generic
    // ones: sf's `devHubs`/`sandboxes` are filtered *subsets* of
    // `nonScratchOrgs`, so walking `nonScratchOrgs` first would claim every
    // username and mislabel all hubs and sandboxes as "Other".
    let mut seen = std::collections::HashSet::<String>::new();

    for key in &[
        "scratchOrgs",
        "devHubs",
        "sandboxes",
        "nonScratchOrgs",
        "other",
    ] {
        if let Some(arr) = result.get(*key).and_then(Value::as_array) {
            for entry in arr {
                let username = entry
                    .get("username")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if username.is_empty() || !seen.insert(username.clone()) {
                    continue;
                }
                let alias = entry
                    .get("alias")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let instance_url = entry
                    .get("instanceUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let is_default = entry
                    .get("isDefaultUsername")
                    .and_then(Value::as_bool)
                    .or_else(|| {
                        entry
                            .get("isDefaultDevHubUsername")
                            .and_then(Value::as_bool)
                    })
                    .unwrap_or(false);
                let connected_status = entry
                    .get("connectedStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown")
                    .to_string();
                let expiration_date = entry
                    .get("expirationDate")
                    .and_then(Value::as_str)
                    .map(String::from);
                let dev_hub_username = entry
                    .get("devHubUsername")
                    .or_else(|| entry.get("devHubOrgId"))
                    .and_then(Value::as_str)
                    .map(String::from);

                out.push(OrgEntry {
                    alias: if alias.is_empty() {
                        username.clone()
                    } else {
                        alias
                    },
                    username,
                    instance_url,
                    is_default,
                    connected_status,
                    org_type: org_type_for_bucket(key).to_string(),
                    expiration_date,
                    dev_hub_username,
                });
            }
        }
    }

    Ok(out)
}
