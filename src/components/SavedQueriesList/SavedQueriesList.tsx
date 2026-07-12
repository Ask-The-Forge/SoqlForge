/**
 * SavedQueriesList — sidebar panel for the user's manually-saved queries.
 *
 * Distinct from History (which records everything that ran). Saved queries
 * persist across sessions and are intended for stuff the user goes back to:
 * monthly reports, debugging queries they keep iterating on, etc.
 *
 * Interactions:
 *   - Click an entry to load it back into the editor (including its toggle
 *     state for Tooling / Bulk / All Rows).
 *   - Hover an entry: a × button appears to delete it.
 *   - Double-click the name to rename it inline (prompt — keeping it small).
 *
 * The "Save current query" button lives at the top of the panel and writes
 * the editor's current text + toggle state into the store with a default
 * name (first non-keyword token after SELECT, or the truncated query if we
 * can't pick a sensible one).
 */

import { useState } from "react";
import { useAppStore, type SavedQuery } from "../../stores/appStore";
import { extractFromObject } from "../../lib/schemaCache";

interface SavedQueriesListProps {
  /** Current editor text — used when the user clicks "Save current". */
  currentQuery: string;
  /** Current toggle state — saved alongside the query. */
  useToolingApi: boolean;
  useBulkApi: boolean;
  allRows: boolean;
  /** Called when the user clicks a saved entry to load it back. */
  onLoad: (q: SavedQuery) => void;
}

function defaultName(query: string): string {
  // Pick a sensible default: the OUTER query's FROM-object if we can find
  // one (depth-aware — `SELECT Id, (SELECT … FROM Contacts) FROM Account`
  // names the query "Account", not "Contacts"), otherwise the first 40 chars.
  const from = extractFromObject(query);
  if (from) return from;
  return query.replace(/\s+/g, " ").trim().slice(0, 40) || "Untitled";
}

export function SavedQueriesList({
  currentQuery,
  useToolingApi,
  useBulkApi,
  allRows,
  onLoad,
}: SavedQueriesListProps) {
  const saved = useAppStore((s) => s.savedQueries);
  const saveQuery = useAppStore((s) => s.saveQuery);
  const renameSavedQuery = useAppStore((s) => s.renameSavedQuery);
  const deleteSavedQuery = useAppStore((s) => s.deleteSavedQuery);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleSave = () => {
    const trimmed = currentQuery.trim();
    if (!trimmed) return;
    saveQuery({
      name: defaultName(trimmed),
      query: trimmed,
      useToolingApi,
      useBulkApi,
      allRows,
    });
  };

  const handleRename = (q: SavedQuery) => {
    // Prompt is intentionally simple; can upgrade to inline edit later.
    // eslint-disable-next-line no-alert
    const next = window.prompt("Rename query:", q.name);
    if (next != null && next.trim() && next.trim() !== q.name) {
      renameSavedQuery(q.id, next.trim());
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden border-b border-zinc-800">
      <div className="flex items-center px-3 py-2 border-b border-zinc-800">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Saved
        </span>
        <button
          onClick={handleSave}
          disabled={!currentQuery.trim()}
          className="ml-auto text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
          title="Save the current query"
        >
          + Save
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {saved.length === 0 ? (
          <div className="p-3 text-xs text-zinc-600">
            Click + Save to keep the current query here.
          </div>
        ) : (
          <ul className="text-xs">
            {saved.map((q) => (
              <li
                key={q.id}
                onMouseEnter={() => setHoveredId(q.id)}
                onMouseLeave={() => setHoveredId(null)}
                className="px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900"
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onLoad(q)}
                    onDoubleClick={() => handleRename(q)}
                    className="flex-1 text-left text-zinc-200 truncate cursor-pointer"
                    title={`${q.name}\n\n${q.query}\n\nDouble-click to rename.`}
                  >
                    {q.name}
                  </button>
                  {hoveredId === q.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          window.confirm(`Delete saved query "${q.name}"?`)
                        ) {
                          deleteSavedQuery(q.id);
                        }
                      }}
                      className="text-zinc-500 hover:text-red-400 leading-none"
                      title="Delete"
                      aria-label="Delete saved query"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 mt-0.5">
                  <span className="font-mono truncate">
                    {q.query.replace(/\s+/g, " ")}
                  </span>
                </div>
                {(q.useToolingApi || q.useBulkApi || q.allRows) && (
                  <div className="flex items-center gap-2 text-[10px] mt-0.5">
                    {q.useToolingApi && (
                      <span className="text-blue-400">tooling</span>
                    )}
                    {q.useBulkApi && (
                      <span className="text-purple-400">bulk</span>
                    )}
                    {q.allRows && (
                      <span className="text-amber-400">all rows</span>
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
