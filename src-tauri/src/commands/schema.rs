//! Schema introspection commands. Wraps `sf sobject describe`.
//!
//! Returns just the fields list for now — full describe output is large (40-60KB
//! per object) and the v1 use case (autocomplete) only needs names + types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::run_sf_json;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub name: String,
    pub custom: bool,
}

#[tauri::command]
pub async fn list_objects(org_alias: String) -> Result<Vec<ObjectInfo>, AppError> {
    // `sf sobject list -o <alias> --json` returns a flat array of name strings:
    //   { status: 0, result: ["Account", "Contact", "MyThing__c", ...] }
    // (No labels — `sf sobject list-all` or per-object describe would give
    // richer data but is much slower.)
    let result = run_sf_json(&["sobject", "list", "-o", &org_alias, "--json"]).await?;
    let arr = result.as_array().cloned().unwrap_or_default();

    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        if let Some(name) = v.as_str() {
            let custom = name.ends_with("__c") || name.ends_with("__b") || name.ends_with("__e");
            out.push(ObjectInfo {
                name: name.to_string(),
                custom,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PicklistValue {
    pub value: String,
    pub label: String,
    pub active: bool,
    pub default_value: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub name: String,
    /// Salesforce field type, e.g. "string", "id", "datetime", "reference".
    pub field_type: String,
    pub label: String,
    /// For reference fields, the SObject(s) the relationship points to.
    pub reference_to: Vec<String>,
    /// Relationship traversal name (e.g. "Account" for AccountId → Account.Name).
    /// None for non-reference fields.
    pub relationship_name: Option<String>,
    /// Whether the user can write to this field (false for formula fields,
    /// calculated fields, locked-down system fields, etc.). Comes from
    /// `updateable` in the describe.
    pub updateable: bool,
    /// True for formula (and roll-up summary) fields — lets the UI explain
    /// WHY a field is read-only instead of silently refusing to edit.
    pub calculated: bool,
    /// For picklist / multipicklist fields, the available values. Empty for
    /// other field types.
    pub picklist_values: Vec<PicklistValue>,
}

/// Inbound relationship — the parent referencing back to a child via a
/// foreign key. Used by SOQL subqueries: `SELECT … (SELECT … FROM Contacts)
/// FROM Account` resolves "Contacts" through Account's child relationships
/// to find the child SObject (Contact).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildRelationshipInfo {
    pub child_sobject: String,
    /// The name to use in a subquery FROM. Sometimes null (anonymous rels).
    pub relationship_name: Option<String>,
    /// The FK field on the child object that points back at us.
    pub field: String,
}

/// Combined describe result — fields + child relationships in a single
/// call so the cache layer only pays one `sf sobject describe` round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSchema {
    pub fields: Vec<FieldInfo>,
    pub child_relationships: Vec<ChildRelationshipInfo>,
}

#[tauri::command]
pub async fn describe_object(
    org_alias: String,
    object_name: String,
) -> Result<ObjectSchema, AppError> {
    // sf sobject describe -s <Object> -o <alias> --json
    // Returns: { fields: [...], name, label, ... }
    let result = run_sf_json(&[
        "sobject",
        "describe",
        "-s",
        &object_name,
        "-o",
        &org_alias,
        "--json",
    ])
    .await?;

    let fields_raw = result
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut fields = Vec::with_capacity(fields_raw.len());
    for f in fields_raw {
        let name = f
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let field_type = f
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let label = f
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let reference_to = f
            .get("referenceTo")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let relationship_name = f
            .get("relationshipName")
            .and_then(Value::as_str)
            .map(String::from)
            .filter(|s| !s.is_empty());

        let updateable = f
            .get("updateable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let calculated = f
            .get("calculated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let picklist_values = f
            .get("picklistValues")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let value = p
                            .get("value")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if value.is_empty() {
                            return None;
                        }
                        let label = p
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or(&value)
                            .to_string();
                        let active = p.get("active").and_then(Value::as_bool).unwrap_or(true);
                        let default_value = p
                            .get("defaultValue")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        Some(PicklistValue {
                            value,
                            label,
                            active,
                            default_value,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        fields.push(FieldInfo {
            name,
            field_type,
            label,
            reference_to,
            relationship_name,
            updateable,
            calculated,
            picklist_values,
        });
    }

    // Parse childRelationships — these power subquery completion.
    let crs_raw = result
        .get("childRelationships")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut child_relationships = Vec::with_capacity(crs_raw.len());
    for cr in crs_raw {
        let child_sobject = cr
            .get("childSObject")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if child_sobject.is_empty() {
            continue;
        }
        let relationship_name = cr
            .get("relationshipName")
            .and_then(Value::as_str)
            .map(String::from)
            .filter(|s| !s.is_empty());
        let field = cr
            .get("field")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        child_relationships.push(ChildRelationshipInfo {
            child_sobject,
            relationship_name,
            field,
        });
    }

    Ok(ObjectSchema {
        fields,
        child_relationships,
    })
}
