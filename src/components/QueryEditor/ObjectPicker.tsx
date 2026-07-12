/**
 * ObjectPicker — SOQLXplorer-style "pick an object, get a populated SELECT".
 *
 * Opens a small searchable popover anchored to its button. Picking an object:
 *   1. Loads its describe (if not cached)
 *   2. Generates `SELECT a, b, c FROM Object LIMIT 200` with EVERY field
 *   3. Hands the SOQL back via onPick — caller replaces editor content.
 *
 * Custom relationship reference fields like `AccountId` are included; the
 * relationship-only names (`Account`) are not, because the describe only
 * emits scalar field entries (relationships are surfaced via the FK + a
 * relationshipName on the FK field).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../stores/appStore";
import {
  clearObjectsFailure,
  getCachedFields,
  loadFields,
  loadObjectsFor,
} from "../../lib/schemaCache";
import type { ObjectInfo } from "../../lib/tauriClient";

interface ObjectPickerProps {
  /** Disabled when there's no active org. */
  disabled?: boolean;
  /** Called with the generated SOQL when the user picks an object. */
  onPick: (soql: string) => void;
}

const MAX_ROWS = 200;
const DEFAULT_LIMIT = 200;

export function ObjectPicker({ disabled, onPick }: ObjectPickerProps) {
  const activeOrg = useAppStore((s) => s.activeOrg);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [objects, setObjects] = useState<ObjectInfo[]>([]);
  const [busyFor, setBusyFor] = useState<string | null>(null);
  // Loading vs failed matters: `loadObjectsFor` returns [] on BOTH "still
  // loading never happens (it awaits)" and "sf sobject list failed" — without
  // tracking it here the popover showed a perpetual "Loading…" on failure.
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch object catalog when we open (idempotent; cached after first call).
  useEffect(() => {
    if (!open || !activeOrg) return;
    setLoadFailed(false);
    void loadObjectsFor(activeOrg).then((objs) => {
      setObjects(objs);
      // An org genuinely has hundreds of objects; an empty list means the
      // listObjects call failed (errors are swallowed into [] by the cache).
      setLoadFailed(objs.length === 0);
    });
  }, [open, activeOrg, retryNonce]);

  // Focus the filter input when the popover opens.
  useEffect(() => {
    if (open) {
      // Defer one tick so the input is mounted.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    // Defer subscription so the click that opened the popover doesn't
    // immediately close it.
    const id = window.setTimeout(
      () => document.addEventListener("mousedown", handler),
      0,
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // Stable A→Z order. Custom objects intermingled (they sort under "C…"
    // by their *full* name, which is normal Salesforce behavior).
    const sorted = [...objects].sort((a, b) => a.name.localeCompare(b.name));
    if (!f) return sorted.slice(0, MAX_ROWS);
    // Substring filter. Cap to MAX_ROWS so a giant org doesn't blow up DOM.
    return sorted.filter((o) => o.name.toLowerCase().includes(f)).slice(0, MAX_ROWS);
  }, [objects, filter]);

  async function buildAndPick(objectName: string) {
    if (!activeOrg) return;
    setBusyFor(objectName);
    try {
      let fields = getCachedFields(activeOrg, objectName);
      if (!fields) {
        fields = await loadFields(activeOrg, objectName);
      }
      const names =
        fields && fields.length > 0 ? fields.map((f) => f.name) : ["Id"];
      // Multi-line for readability — easier to skim a 200-field SELECT.
      const selectClause = names.join(", ");
      const soql = `SELECT ${selectClause}\nFROM ${objectName}\nLIMIT ${DEFAULT_LIMIT}`;
      onPick(soql);
    } finally {
      setBusyFor(null);
      setOpen(false);
      setFilter("");
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !activeOrg}
        className={
          "text-xs border rounded px-2 py-0.5 transition-colors " +
          (open
            ? "bg-blue-600 border-blue-500 text-white"
            : "text-zinc-300 border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed")
        }
        title={
          activeOrg
            ? "Pick an object — generates SELECT with all its fields"
            : "Select an org first"
        }
      >
        From…
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-72 bg-zinc-900 border border-zinc-700 rounded shadow-xl flex flex-col">
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={
              objects.length === 0
                ? "Loading objects…"
                : `Filter ${objects.length} objects…`
            }
            className="w-full px-2 py-1.5 text-sm bg-zinc-950 text-zinc-100 border-b border-zinc-800 outline-none placeholder-zinc-500 font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered.length > 0) {
                e.preventDefault();
                void buildAndPick(filtered[0].name);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                setFilter("");
              }
            }}
          />
          <div className="max-h-80 overflow-y-auto">
            {loadFailed && objects.length === 0 ? (
              <div className="px-2 py-3 text-xs text-red-400 flex items-center gap-2">
                <span>Couldn't load objects for this org.</span>
                <button
                  type="button"
                  onClick={() => {
                    if (activeOrg) clearObjectsFailure(activeOrg);
                    setRetryNonce((n) => n + 1);
                  }}
                  className="border border-zinc-700 hover:border-zinc-500 rounded px-1.5 py-0.5 text-zinc-300 hover:text-zinc-100"
                >
                  Retry
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-xs text-zinc-500">
                {objects.length === 0 ? "Loading…" : "No matches"}
              </div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.name}
                  type="button"
                  onClick={() => void buildAndPick(o.name)}
                  className="w-full text-left px-2 py-1 text-xs text-zinc-200 hover:bg-blue-600/30 flex items-center justify-between gap-2"
                >
                  <span className="font-mono truncate">{o.name}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {o.custom && (
                      <span className="text-[10px] text-amber-400">
                        custom
                      </span>
                    )}
                    {busyFor === o.name && (
                      <span className="text-[10px] text-zinc-500">…</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
          {filter && filtered.length === MAX_ROWS && (
            <div className="px-2 py-1 text-[10px] text-zinc-500 border-t border-zinc-800">
              Showing first {MAX_ROWS} — refine the filter to see more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
