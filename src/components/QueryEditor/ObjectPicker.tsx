/**
 * ObjectPicker — SOQLXplorer-style "pick an object, get a populated SELECT".
 *
 * Opens a small searchable popover anchored to its button. Picking an object:
 *   1. Loads its describe (if not cached)
 *   2. Generates `SELECT a, b, c FROM Object LIMIT 200` with EVERY field
 *   3. Hands the SOQL back via onPick — caller replaces editor content.
 *
 * Both round-trips (the object catalog, then the describe) show explicit
 * loading state — on a cold cache the describe takes seconds, and the popover
 * stays open the whole time, so silence read as a hang.
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
  compareObjectsForSuggestion,
  getCachedFields,
  loadFields,
  loadObjectsFor,
} from "../../lib/schemaCache";
import type { ObjectInfo } from "../../lib/tauriClient";
import { Spinner } from "../shared/Spinner";

interface ObjectPickerProps {
  /** Disabled when there's no active org. */
  disabled?: boolean;
  /** FROM-object currently in the editor. Shown on the button so the control
   *  reads as "this is what the query is pointed at", not just an action. */
  currentObject?: string | null;
  /** Called with the generated SOQL when the user picks an object. */
  onPick: (soql: string) => void;
}

const MAX_ROWS = 200;
const DEFAULT_LIMIT = 200;

export function ObjectPicker({
  disabled,
  currentObject,
  onPick,
}: ObjectPickerProps) {
  const activeOrg = useAppStore((s) => s.activeOrg);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [objects, setObjects] = useState<ObjectInfo[]>([]);
  const [busyFor, setBusyFor] = useState<string | null>(null);
  // Loading vs failed matters: `loadObjectsFor` returns [] on BOTH "still
  // loading never happens (it awaits)" and "sf sobject list failed" — without
  // tracking it here the popover showed a perpetual "Loading…" on failure.
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch object catalog when we open (idempotent; cached after first call).
  // The `cancelled` guard keeps a slow load for a previous org from landing
  // on top of the list for the one the user switched to.
  useEffect(() => {
    if (!open || !activeOrg) return;
    let cancelled = false;
    setLoadFailed(false);
    setObjectsLoading(true);
    void loadObjectsFor(activeOrg)
      .then((objs) => {
        if (cancelled) return;
        setObjects(objs);
        // An org genuinely has hundreds of objects; an empty list means the
        // listObjects call failed (errors are swallowed into [] by the cache).
        setLoadFailed(objs.length === 0);
      })
      .finally(() => {
        if (!cancelled) setObjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
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
    // Custom objects first, then standard, then the auto-generated companions
    // (AccountHistory, AccountShare, …); A→Z inside each tier. Matters most
    // under the MAX_ROWS cap, where the companions would otherwise push the
    // objects you actually query off the end of the list.
    const sorted = [...objects].sort(compareObjectsForSuggestion);
    if (!f) return sorted.slice(0, MAX_ROWS);
    // Substring filter. Cap to MAX_ROWS so a giant org doesn't blow up DOM.
    return sorted.filter((o) => o.name.toLowerCase().includes(f)).slice(0, MAX_ROWS);
  }, [objects, filter]);

  async function buildAndPick(objectName: string) {
    if (!activeOrg) return;
    if (busyFor) return; // a describe is already in flight — ignore double-picks
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
          "flex items-center gap-1.5 text-xs border rounded px-2 py-1 transition-colors " +
          (open
            ? "bg-blue-600 border-blue-500 text-white"
            : "bg-zinc-800 text-zinc-100 border-zinc-600 hover:bg-zinc-700 hover:border-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed")
        }
        title={
          activeOrg
            ? "Pick an object — builds a SELECT with all of its fields"
            : "Select an org first"
        }
      >
        {busyFor ? (
          <Spinner className="text-blue-300" />
        ) : (
          <span aria-hidden="true">▤</span>
        )}
        <span className="font-medium">Select Object</span>
        {currentObject && (
          <span
            className={
              "font-mono max-w-[14ch] truncate " +
              (open ? "text-blue-100" : "text-zinc-400")
            }
            title={`Current FROM object: ${currentObject}`}
          >
            · {currentObject}
          </span>
        )}
        <span className="text-[10px] opacity-70" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-72 bg-zinc-900 border border-zinc-700 rounded shadow-xl flex flex-col">
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={
              objectsLoading && objects.length === 0
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
              <div className="px-2 py-3 text-xs text-zinc-500 flex items-center gap-2">
                {objects.length === 0 ? (
                  <>
                    <Spinner className="text-zinc-400" />
                    Loading objects…
                  </>
                ) : (
                  "No matches"
                )}
              </div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.name}
                  type="button"
                  onClick={() => void buildAndPick(o.name)}
                  disabled={!!busyFor}
                  className="w-full text-left px-2 py-1 text-xs text-zinc-200 hover:bg-blue-600/30 disabled:hover:bg-transparent flex items-center justify-between gap-2"
                >
                  <span className="font-mono truncate">{o.name}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {o.custom && (
                      <span className="text-[10px] text-amber-400">
                        custom
                      </span>
                    )}
                    {busyFor === o.name && (
                      <Spinner className="text-blue-400" />
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

          {/* Describing an object takes a CLI round-trip (seconds on a cold
              cache, and the popover stays open the whole time) — cover the
              list so it's obvious the app is working, not stuck. */}
          {busyFor && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-zinc-900/90 rounded">
              <Spinner size={20} className="text-blue-400" label="Loading" />
              <div className="text-xs text-zinc-200 font-mono">{busyFor}</div>
              <div className="text-[10px] text-zinc-500">
                Loading fields, building SELECT…
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
