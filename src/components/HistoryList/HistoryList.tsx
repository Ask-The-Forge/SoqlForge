/**
 * HistoryList — sidebar showing recent queries. Click an entry to load it
 * into the editor.
 *
 * The store dedupes on push, so this is a list of *distinct* queries at their
 * most recent run, not a run log. Each row leads with the FROM object so the
 * list can be scanned by target instead of by reading SOQL, and the search box
 * filters on the query text and the org alias.
 */

import { useMemo, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { extractFromObject } from "../../lib/schemaCache";

interface HistoryListProps {
  onPick: (query: string, useToolingApi: boolean) => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function HistoryList({ onPick }: HistoryListProps) {
  const history = useAppStore((s) => s.history);
  const [filter, setFilter] = useState("");

  // Derive the object name and the single-line form once per history change,
  // not on every keystroke — extractFromObject scans the whole query.
  const rows = useMemo(
    () =>
      history.map((h) => ({
        entry: h,
        object: extractFromObject(h.query),
        oneLine: h.query.replace(/\s+/g, " ").trim(),
      })),
    [history],
  );

  const visible = useMemo(() => {
    // AND of whitespace-separated terms: "account name" matches
    // `SELECT Name FROM Account`, which a plain substring search wouldn't.
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return rows;
    return rows.filter((r) => {
      const hay = `${r.oneLine} ${r.entry.org ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, filter]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span className="text-xs uppercase tracking-wide text-zinc-500 shrink-0">
          History
        </span>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search..."
          aria-label="Search history"
          title="Filter by query text or org (Esc to clear)"
          className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] bg-zinc-900 text-zinc-200 border border-zinc-800 rounded outline-none placeholder-zinc-600 focus:border-zinc-600"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setFilter("");
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <div className="p-3 text-xs text-zinc-600">No queries yet.</div>
        ) : visible.length === 0 ? (
          <div className="p-3 text-xs text-zinc-600">
            No queries match "{filter.trim()}".
          </div>
        ) : (
          <ul className="text-xs">
            {visible.map(({ entry: h, object, oneLine }) => (
              <li
                // Query + API mode is exactly the store's dedupe key, so it's
                // unique across the list — stable through filtering.
                key={`${h.useToolingApi ? "T" : "R"} ${h.query}`}
                onClick={() => onPick(h.query, h.useToolingApi)}
                className="px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900 cursor-pointer"
                title={h.query}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={`truncate ${object ? "text-zinc-200" : "text-zinc-600"}`}
                  >
                    {object ?? "—"}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-500">
                    {relativeTime(h.ts)}
                  </span>
                </div>
                <div className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
                  {oneLine}
                </div>
                {(h.useToolingApi || h.org) && (
                  <div className="flex items-center gap-2 text-[10px] mt-0.5">
                    {h.useToolingApi && (
                      <span className="text-blue-400">tooling</span>
                    )}
                    {h.org && (
                      <span className="text-zinc-600 truncate" title={h.org}>
                        {h.org}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
