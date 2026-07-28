/**
 * Typed wrappers around Tauri's `invoke`. Components MUST go through these,
 * never call `invoke` directly — the wrappers are the IPC contract.
 *
 * Every wrapper validates the response with zod so runtime drift between Rust
 * and TypeScript shows up as a clear error instead of a silent `undefined`.
 */

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Error envelope
// ─────────────────────────────────────────────────────────────────────────────

export type AppErrorCode =
  | "CLI_NOT_FOUND"
  | "AUTH_EXPIRED"
  | "QUERY_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "CLI_ERROR"
  | "PARSE_ERROR"
  | "IO_ERROR";

export interface AppError {
  code: AppErrorCode;
  message: string;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { code: unknown }).code === "string"
  );
}

/** Convert thrown anything into an AppError-shaped object the UI can render. */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) return { code: "IO_ERROR", message: e.message };
  if (typeof e === "string") return { code: "IO_ERROR", message: e };
  return { code: "IO_ERROR", message: "Unknown error" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Org listing
// ─────────────────────────────────────────────────────────────────────────────

export const OrgEntrySchema = z.object({
  alias: z.string(),
  username: z.string(),
  instanceUrl: z.string(),
  isDefault: z.boolean(),
  connectedStatus: z.string(),
  /** "Scratch" | "Sandbox" | "DevHub" | "Other" */
  orgType: z.string(),
  /** Scratch orgs only — ISO date the org expires. */
  expirationDate: z.string().nullable().optional(),
  /** Scratch orgs only — the DevHub username that created it. */
  devHubUsername: z.string().nullable().optional(),
});
export type OrgEntry = z.infer<typeof OrgEntrySchema>;

export async function listOrgs(): Promise<OrgEntry[]> {
  const raw = await invoke("list_orgs");
  return z.array(OrgEntrySchema).parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Org management (login/logout/default/alias/open/delete-scratch)
// ─────────────────────────────────────────────────────────────────────────────

export async function orgLoginWeb(
  alias?: string,
  instanceUrl?: string,
): Promise<OrgEntry> {
  const raw = await invoke("org_login_web", {
    alias: alias || null,
    instanceUrl: instanceUrl || null,
  });
  return OrgEntrySchema.parse(raw);
}

export async function orgLogout(username: string): Promise<void> {
  await invoke("org_logout", { username });
}

export async function orgSetDefault(username: string): Promise<void> {
  await invoke("org_set_default", { username });
}

export async function orgSetAlias(username: string, alias: string): Promise<void> {
  await invoke("org_set_alias", { username, alias });
}

export async function orgOpen(username: string): Promise<void> {
  await invoke("org_open", { username });
}

export async function orgDeleteScratch(username: string): Promise<void> {
  await invoke("org_delete_scratch", { username });
}

// ─────────────────────────────────────────────────────────────────────────────
// DevHub packages
// ─────────────────────────────────────────────────────────────────────────────

export const PackageInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  packageType: z.string(),
  namespacePrefix: z.string().nullable().optional(),
});
export type PackageInfo = z.infer<typeof PackageInfoSchema>;

export async function listPackages(devHubAlias: string): Promise<PackageInfo[]> {
  const raw = await invoke("list_packages", { devHubAlias });
  return z.array(PackageInfoSchema).parse(raw);
}

export const PackageVersionInfoSchema = z.object({
  id: z.string(),
  subscriberPackageVersionId: z.string().nullable().optional(),
  packageId: z.string(),
  version: z.string(),
  isReleased: z.boolean(),
  createdDate: z.string().nullable().optional(),
});
export type PackageVersionInfo = z.infer<typeof PackageVersionInfoSchema>;

export async function listPackageVersions(
  devHubAlias: string,
  packageId?: string,
): Promise<PackageVersionInfo[]> {
  const raw = await invoke("list_package_versions", {
    devHubAlias,
    packageId: packageId || null,
  });
  return z.array(PackageVersionInfoSchema).parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema (sobject describe)
// ─────────────────────────────────────────────────────────────────────────────

export const PicklistValueSchema = z.object({
  value: z.string(),
  label: z.string(),
  active: z.boolean(),
  defaultValue: z.boolean(),
});
export type PicklistValue = z.infer<typeof PicklistValueSchema>;

export const FieldInfoSchema = z.object({
  name: z.string(),
  fieldType: z.string(),
  label: z.string(),
  referenceTo: z.array(z.string()),
  relationshipName: z.string().nullable().optional(),
  updateable: z.boolean(),
  /** Formula / roll-up summary fields — read-only by definition. Optional so
   *  cached describes from older builds still parse. */
  calculated: z.boolean().optional(),
  picklistValues: z.array(PicklistValueSchema),
});
export type FieldInfo = z.infer<typeof FieldInfoSchema>;

export const ChildRelationshipInfoSchema = z.object({
  childSobject: z.string(),
  relationshipName: z.string().nullable().optional(),
  field: z.string(),
});
export type ChildRelationshipInfo = z.infer<typeof ChildRelationshipInfoSchema>;

export const ObjectSchemaSchema = z.object({
  fields: z.array(FieldInfoSchema),
  childRelationships: z.array(ChildRelationshipInfoSchema),
});
export type ObjectSchema = z.infer<typeof ObjectSchemaSchema>;

export async function describeObject(
  orgAlias: string,
  objectName: string,
): Promise<ObjectSchema> {
  const raw = await invoke("describe_object", { orgAlias, objectName });
  return ObjectSchemaSchema.parse(raw);
}

export const ObjectInfoSchema = z.object({
  name: z.string(),
  custom: z.boolean(),
});
export type ObjectInfo = z.infer<typeof ObjectInfoSchema>;

export async function listObjects(orgAlias: string): Promise<ObjectInfo[]> {
  const raw = await invoke("list_objects", { orgAlias });
  return z.array(ObjectInfoSchema).parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOQL query
// ─────────────────────────────────────────────────────────────────────────────

export const QueryResultSchema = z.object({
  totalSize: z.number(),
  done: z.boolean(),
  records: z.array(z.record(z.string(), z.unknown())),
  columns: z.array(z.string()),
  elapsedMs: z.number(),
  /** Set client-side when the records were synthesized from totalSize (bare
   *  `SELECT COUNT()` returns no records via REST). Never sent by Rust. */
  synthesizedCount: z.boolean().optional(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

export interface QueryOptions {
  /** Hit the Tooling API instead of standard SOQL (ApexClass, CustomField, …). */
  useToolingApi?: boolean;
  /** Run via Bulk API — required for results above ~50k, recommended above 2k. */
  useBulkApi?: boolean;
  /** Include soft-deleted / archived records (queryAll). */
  allRows?: boolean;
}

export async function runSoql(
  orgAlias: string,
  query: string,
  options: QueryOptions = {},
  runId?: string,
): Promise<QueryResult> {
  const raw = await invoke("run_soql", {
    orgAlias,
    query,
    options: {
      useToolingApi: !!options.useToolingApi,
      useBulkApi: !!options.useBulkApi,
      allRows: !!options.allRows,
    },
    runId: runId ?? null,
  });
  return QueryResultSchema.parse(raw);
}

/** Cancel an in-flight runSoql by its runId. Kills the sf subprocess tree;
 *  the pending runSoql promise rejects with code CANCELLED. */
export async function cancelRun(runId: string): Promise<boolean> {
  return (await invoke("cancel_run", { runId })) as boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export const CliSettingsSchema = z.object({
  pathOverride: z.string().nullable().optional(),
  timeoutSecs: z.number(),
});
export type CliSettings = z.infer<typeof CliSettingsSchema>;

export async function getCliSettings(): Promise<CliSettings> {
  const raw = await invoke("get_cli_settings");
  return CliSettingsSchema.parse(raw);
}

export async function setCliSettings(s: CliSettings): Promise<CliSettings> {
  const raw = await invoke("set_cli_settings", { settings: s });
  return CliSettingsSchema.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// File export
// ─────────────────────────────────────────────────────────────────────────────

export const SaveResultSchema = z.object({
  path: z.string().nullable(),
});
export type SaveResult = z.infer<typeof SaveResultSchema>;

/**
 * Show the native save-file dialog and write `content` to the chosen path.
 * Resolves to `{ path: null }` if the user cancelled.
 */
export async function saveCsv(
  content: string,
  defaultFilename: string,
): Promise<SaveResult> {
  const raw = await invoke("save_csv", { content, defaultFilename });
  return SaveResultSchema.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI assist
// ─────────────────────────────────────────────────────────────────────────────

export const AiSettingsSchema = z.object({
  provider: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export async function getAiSettings(): Promise<AiSettings> {
  const raw = await invoke("get_ai_settings");
  return AiSettingsSchema.parse(raw);
}

export async function setAiSettings(s: AiSettings): Promise<AiSettings> {
  const raw = await invoke("set_ai_settings", { settings: s });
  return AiSettingsSchema.parse(raw);
}

export const AiGenerateResultSchema = z.object({
  soql: z.string(),
  model: z.string(),
});
export type AiGenerateResult = z.infer<typeof AiGenerateResultSchema>;

export interface AiGenerateArgs {
  provider: string;
  apiKey: string;
  model?: string | null;
  prompt: string;
  schemaContext?: string | null;
}

export async function aiGenerateSoql(
  args: AiGenerateArgs,
): Promise<AiGenerateResult> {
  const raw = await invoke("ai_generate_soql", { args });
  return AiGenerateResultSchema.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Record update
// ─────────────────────────────────────────────────────────────────────────────

export const UpdateRecordResultSchema = z.object({
  id: z.string(),
  success: z.boolean(),
});
export type UpdateRecordResult = z.infer<typeof UpdateRecordResultSchema>;

export interface UpdateRecordArgs {
  orgAlias: string;
  objectName: string;
  recordId: string;
  /** { FieldApiName: scalar value }. Null clears the field. */
  values: Record<string, string | number | boolean | null>;
}

export async function updateRecord(
  args: UpdateRecordArgs,
): Promise<UpdateRecordResult> {
  const raw = await invoke("update_record", { args });
  return UpdateRecordResultSchema.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Record delete
// ─────────────────────────────────────────────────────────────────────────────

export const DeleteRecordResultSchema = z.object({
  id: z.string(),
  success: z.boolean(),
});
export type DeleteRecordResult = z.infer<typeof DeleteRecordResultSchema>;

export interface DeleteRecordArgs {
  orgAlias: string;
  objectName: string;
  recordId: string;
  /** Delete from a Tooling API object — must match how the row was queried. */
  useToolingApi?: boolean;
}

/** Destructive: deletes the record in the org. Callers MUST confirm first. */
export async function deleteRecord(
  args: DeleteRecordArgs,
): Promise<DeleteRecordResult> {
  const raw = await invoke("delete_record", {
    args: { ...args, useToolingApi: !!args.useToolingApi },
  });
  return DeleteRecordResultSchema.parse(raw);
}
