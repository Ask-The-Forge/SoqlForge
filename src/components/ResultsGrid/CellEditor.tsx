/**
 * CellEditor — picks the right input widget for a Salesforce field type and
 * commits the new value via the parent callback. Pressing Enter commits;
 * Esc cancels; clicking outside (blur) commits too.
 *
 * Field-type mapping:
 *   picklist / multipicklist   → <select> populated from describe
 *   boolean                    → <select> with true/false/(clear)
 *   date / datetime            → <input type="date"|"datetime-local">
 *   int / double / percent /   → <input type="number">
 *     currency
 *   anything else              → <input type="text">
 *
 * Reference (lookup) fields fall through to text — the user types the Id.
 * A proper relationship picker is a future feature.
 */

import { useEffect, useRef, useState } from "react";
import type { FieldInfo } from "../../lib/tauriClient";

export type CommitValue = string | number | boolean | null;

interface CellEditorProps {
  field: FieldInfo;
  initialValue: unknown;
  onCommit: (next: CommitValue) => void;
  onCancel: () => void;
}

function toInputString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v);
}

/** Sentinel for "value failed validation — don't commit". */
export const INVALID_VALUE = Symbol("invalid");

/** Format a Date as the local-time string a `datetime-local` input expects. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Convert the raw value (as typed) to the appropriate JSON value for the
 *  Rust update command. Returns INVALID_VALUE when the input can't be
 *  represented for this field type (caller cancels the edit, nothing is
 *  written to the org). */
function coerceForCommit(
  field: FieldInfo,
  raw: string,
  initialValue: unknown,
): CommitValue | typeof INVALID_VALUE {
  const trimmed = raw.trim();
  // Empty means clear the field (Salesforce-friendly NULL).
  if (trimmed === "") return null;

  switch (field.fieldType) {
    case "boolean":
      // Select renders "true" / "false" / "" — null handled above.
      return trimmed.toLowerCase() === "true";
    case "int":
    case "long":
    case "double":
    case "percent":
    case "currency": {
      const n = Number(trimmed);
      // Garbage typed into a numeric cell must NOT fall through as a string —
      // reject client-side instead of letting sf/Salesforce guess.
      return Number.isFinite(n) ? n : INVALID_VALUE;
    }
    case "datetime": {
      // The datetime-local input yields a zone-less local string; Salesforce
      // parses offset-less datetimes as GMT, which would silently shift the
      // value by the user's UTC offset. Parse as local and send explicit UTC.
      const d = new Date(trimmed);
      if (isNaN(d.getTime())) return INVALID_VALUE;
      // If the instant didn't change, return the ORIGINAL string so the
      // grid's prev===next no-op check suppresses a pointless write.
      if (typeof initialValue === "string") {
        const init = new Date(initialValue);
        if (!isNaN(init.getTime()) && init.getTime() === d.getTime()) {
          return initialValue;
        }
      }
      return d.toISOString();
    }
    default:
      return raw;
  }
}

export function CellEditor({
  field,
  initialValue,
  onCommit,
  onCancel,
}: CellEditorProps) {
  const [raw, setRaw] = useState<string>(toInputString(initialValue));
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  // Auto-focus on mount + select existing text for fast re-entry.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  const commit = () => {
    const v = coerceForCommit(field, raw, initialValue);
    if (v === INVALID_VALUE) {
      // Invalid input: discard the edit instead of writing garbage.
      onCancel();
      return;
    }
    onCommit(v);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  // Picklist / multipicklist → select.
  if (
    (field.fieldType === "picklist" || field.fieldType === "multipicklist") &&
    field.picklistValues.length > 0
  ) {
    const active = field.picklistValues.filter((p) => p.active);
    return (
      <select
        ref={(el) => {
          inputRef.current = el;
        }}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKey}
        className="w-full bg-zinc-950 border border-blue-500 rounded-sm px-1 py-0.5 text-xs text-zinc-100 focus:outline-none"
      >
        <option value="">— clear —</option>
        {/* Pre-populate the current value as an option even if it's not in
            the active list (legacy / inactive picklist values still need to
            display so the user doesn't accidentally clear them). */}
        {raw && !active.some((p) => p.value === raw) && (
          <option value={raw}>{raw} (current)</option>
        )}
        {active.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    );
  }

  // Boolean → 3-state select.
  if (field.fieldType === "boolean") {
    return (
      <select
        ref={(el) => {
          inputRef.current = el;
        }}
        value={raw === "true" ? "true" : raw === "false" ? "false" : ""}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKey}
        className="w-full bg-zinc-950 border border-blue-500 rounded-sm px-1 py-0.5 text-xs text-zinc-100 focus:outline-none"
      >
        <option value="">— clear —</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  // Date / datetime — Salesforce returns ISO strings; HTML date inputs want
  // a specific format. We convert lazily — typing freeform is also fine.
  let inputType: React.HTMLInputTypeAttribute = "text";
  if (field.fieldType === "date") inputType = "date";
  else if (field.fieldType === "datetime") inputType = "datetime-local";
  else if (
    field.fieldType === "int" ||
    field.fieldType === "long" ||
    field.fieldType === "double" ||
    field.fieldType === "percent" ||
    field.fieldType === "currency"
  )
    inputType = "number";

  // For date/datetime, narrow the value down to the format the input expects.
  let inputValue = raw;
  if (inputType === "date" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    inputValue = raw.slice(0, 10);
  } else if (inputType === "datetime-local" && raw.includes("T")) {
    // Salesforce returns UTC (e.g. "…T17:09:02.000+0000"); show it in the
    // user's local time so what they see matches what they'd expect, and
    // coerceForCommit converts back to UTC on save.
    const d = new Date(raw);
    inputValue = isNaN(d.getTime()) ? raw.slice(0, 19) : toLocalInputValue(d);
  }

  return (
    <input
      ref={(el) => {
        inputRef.current = el;
      }}
      type={inputType}
      value={inputValue}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKey}
      className="w-full bg-zinc-950 border border-blue-500 rounded-sm px-1 py-0.5 text-xs text-zinc-100 focus:outline-none font-mono"
    />
  );
}
