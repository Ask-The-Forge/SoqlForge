/**
 * CSV exporter. RFC 4180 quoting: double internal quotes, wrap any field
 * containing comma / quote / newline. Booleans → "true"/"false". Null → "".
 *
 * Flattens dot-notation paths from relationship lookups for each column path
 * (e.g. "Account.Name"), handling BOTH record shapes the two query paths
 * produce — see `flattenValue`.
 *
 * Complex nested values (subquery results, unflattened relationship objects)
 * are reduced to readable text instead of `[object Object]`:
 *   - subquery result `{ totalSize: 3, records: [{Id,Name}, ...] }`
 *     → "3 records: Acme Corp; Initech; Pied Piper"
 *   - plain SObject reference `{ Id, Name, ...attributes }`
 *     → JSON without the attributes envelope
 *   - array → "[N items]" with a few values inlined
 */

/**
 * Read `path` (possibly dotted, e.g. "Account.Owner.Name") out of a record.
 *
 * The two query paths return relationship fields in *different shapes*, and
 * this accessor has to serve both:
 *
 *   REST (`sf data query`)        nested SObjects, one level per segment
 *     { Account: { Name: "Acme", Owner: { Name: "Ada" } } }
 *
 *   Bulk (`sf data export bulk`)  flat keys that literally contain dots,
 *                                 because Bulk API v2 is CSV underneath and
 *                                 its headers are the dotted field paths
 *     { "Account.Name": "Acme", "Account.Owner.Name": "Ada" }
 *
 * So: try the whole path as a literal key first, then fall back to walking
 * segment by segment. Checking the literal key first is unambiguous — a
 * top-level SObject field name can never contain a dot, so a key equal to the
 * full dotted path only ever comes from the Bulk shape.
 *
 * Without the literal-key branch, every relationship column renders blank
 * whenever the Bulk checkbox is on.
 */
export function flattenValue(record: Record<string, unknown>, path: string): unknown {
  if (record && typeof record === "object" && path in record) {
    return record[path];
  }
  const parts = path.split(".");
  let cur: unknown = record;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Recursively remove `attributes` envelopes that Salesforce sprinkles into
 *  nested SObjects — they're never useful in a CSV. */
function stripAttributes(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(stripAttributes);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "attributes") continue;
      out[k] = stripAttributes(val);
    }
    return out;
  }
  return v;
}

/** Pick the "most useful display value" out of a SObject record for inlining
 *  into a summary. Tries Name, then any field that looks name-ish. Exported so
 *  the delete confirmation can name the record it's about to destroy. */
export function pickDisplayValue(rec: Record<string, unknown>): string {
  for (const key of ["Name", "Subject", "Title", "CaseNumber", "Id"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  // Last resort — first scalar value we find.
  for (const v of Object.values(rec)) {
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "";
}

/** Convert any value into a CSV cell string. Public so the grid renderer
 *  can reuse the same logic for consistent display. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";

  if (Array.isArray(v)) {
    const cleaned = v.map(stripAttributes);
    if (cleaned.length === 0) return "[]";
    return `[${cleaned.length} items]`;
  }

  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Subquery result: { totalSize, done, records: [...] }
    if (Array.isArray(obj.records)) {
      const records = (obj.records as Record<string, unknown>[]).map(
        (r) => stripAttributes(r) as Record<string, unknown>,
      );
      if (records.length === 0) return "0 records";
      const sample = records
        .slice(0, 5)
        .map(pickDisplayValue)
        .filter(Boolean)
        .join("; ");
      const total =
        typeof obj.totalSize === "number" ? obj.totalSize : records.length;
      const more = records.length < total ? "…" : "";
      return sample
        ? `${total} record${total === 1 ? "" : "s"}: ${sample}${more}`
        : `${total} record${total === 1 ? "" : "s"}`;
    }
    // Plain SObject reference — JSON without the attributes envelope.
    const stripped = stripAttributes(obj) as Record<string, unknown>;
    try {
      return JSON.stringify(stripped);
    } catch {
      return String(v);
    }
  }

  return String(v);
}

function escape(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Spreadsheet-formula-injection guard: a record value of `=HYPERLINK(...)`
 *  (or `@`, `+`, tab-prefixed payloads) executes when the CSV opens in Excel.
 *  Prefix a `'` so the cell renders as text. Negative/signed numbers are left
 *  alone — they're data, not formulas. */
function guardFormula(s: string): string {
  if (!s) return s;
  const c = s[0];
  if (c === "=" || c === "@" || c === "\t" || c === "\r") return "'" + s;
  if (
    (c === "+" || c === "-") &&
    !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)
  ) {
    return "'" + s;
  }
  return s;
}

/**
 * The CSV header line, prefixed with a UTF-8 BOM so the file opens cleanly in
 * Excel/Numbers/Sheets without encoding fuss. A full export is this plus
 * `"\r\n" + csvRowLines(chunk, columns)` per chunk of records — chunked so
 * six-figure row counts never materialize as a single giant string (that
 * OOM'd the WebView, both as the JS string and again inside the IPC message).
 */
export function csvHeaderLine(
  columns: string[],
  /** Optional pretty header per column (e.g. "COUNT(Id)" for key "expr0").
   *  Falls back to the column key. */
  headerLabels?: Map<string, string>,
): string {
  return "﻿" + columns.map((c) => escape(headerLabels?.get(c) ?? c)).join(",");
}

/** Serialize a batch of records as CSV lines joined with Excel-friendly \r\n
 *  (no leading or trailing newline). */
export function csvRowLines(
  records: Record<string, unknown>[],
  columns: string[],
): string {
  return records
    .map((rec) =>
      columns
        .map((col) => escape(guardFormula(csvCell(flattenValue(rec, col)))))
        .join(","),
    )
    .join("\r\n");
}

/**
 * Tab-separated rendering of the same table, for the clipboard — pastes
 * straight into Excel / Sheets / a Slack message.
 *
 * TSV has no quoting convention the various consumers agree on, so embedded
 * tabs and newlines are flattened to a single space instead of escaped: a
 * mangled cell beats a row that silently splits into three.
 */
export function buildTsv(
  records: Record<string, unknown>[],
  columns: string[],
  headerLabels?: Map<string, string>,
): string {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, " ");
  const lines: string[] = [];
  lines.push(columns.map((c) => flat(headerLabels?.get(c) ?? c)).join("\t"));
  for (const rec of records) {
    lines.push(
      columns
        .map((col) => flat(guardFormula(csvCell(flattenValue(rec, col)))))
        .join("\t"),
    );
  }
  return lines.join("\r\n");
}
