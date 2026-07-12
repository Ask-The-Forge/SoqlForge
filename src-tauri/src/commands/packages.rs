//! DevHub package + package-version listing. Wraps `sf package list` and
//! `sf package version list` (2GP packages only — that's all the `sf`
//! `package` topic covers).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::run_sf_json;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub id: String,
    pub name: String,
    /// "Managed" | "Unlocked" | "Locked" — `sf`'s `ContainerOptions` field.
    pub package_type: String,
    pub namespace_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageVersionInfo {
    pub id: String,
    pub subscriber_package_version_id: Option<String>,
    pub package_id: String,
    pub version: String,
    pub is_released: bool,
    pub created_date: Option<String>,
}

fn str_field(entry: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| entry.get(*k).and_then(Value::as_str))
        .map(String::from)
}

#[tauri::command]
pub async fn list_packages(dev_hub_alias: String) -> Result<Vec<PackageInfo>, AppError> {
    let result = run_sf_json(&[
        "package",
        "list",
        "--target-dev-hub",
        &dev_hub_alias,
        "--json",
    ])
    .await?;

    let arr = result.as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|entry| {
            let id = str_field(entry, &["Id", "PackageId", "SubscriberPackageId"])?;
            let name = str_field(entry, &["Name", "PackageName"]).unwrap_or_else(|| id.clone());
            let package_type = str_field(entry, &["ContainerOptions", "PackageType"])
                .unwrap_or_else(|| "Unknown".into());
            let namespace_prefix = str_field(entry, &["NamespacePrefix"]).filter(|s| !s.is_empty());
            Some(PackageInfo {
                id,
                name,
                package_type,
                namespace_prefix,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn list_package_versions(
    dev_hub_alias: String,
    package_id: Option<String>,
) -> Result<Vec<PackageVersionInfo>, AppError> {
    let mut args: Vec<&str> = vec![
        "package",
        "version",
        "list",
        "--target-dev-hub",
        &dev_hub_alias,
    ];
    if let Some(id) = package_id.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--packages");
        args.push(id);
    }
    args.push("--json");

    let result = run_sf_json(&args).await?;
    let arr = result.as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|entry| {
            let id = str_field(entry, &["Id", "SubscriberPackageVersionId"])?;
            let package_id = str_field(entry, &["Package2Id", "PackageId"]).unwrap_or_default();
            let version =
                str_field(entry, &["Version", "VersionNumber"]).unwrap_or_else(|| "Unknown".into());
            let is_released = entry
                .get("IsReleased")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let created_date = str_field(entry, &["CreatedDate"]);
            let subscriber_package_version_id = str_field(entry, &["SubscriberPackageVersionId"]);
            Some(PackageVersionInfo {
                id,
                subscriber_package_version_id,
                package_id,
                version,
                is_released,
                created_date,
            })
        })
        .collect())
}
