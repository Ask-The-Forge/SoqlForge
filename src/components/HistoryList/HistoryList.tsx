/**
 * HistoryList — collapsible sidebar showing recent queries.
 * Click an entry to load it into the editor.
 */

import { useAppStore } from "../../stores/appStore";

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
        History
      </div>
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <div className="p-3 text-xs text-zinc-600">No queries yet.</div>
        ) : (
          <ul className="text-xs">
            {history.map((h, i) => (
              <li
                key={i}
                onClick={() => onPick(h.query, h.useToolingApi)}
                className="px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900 cursor-pointer group"
                title={h.query}
              >
                <div className="text-zinc-200 font-mono truncate">
                  {h.query.replace(/\s+/g, " ")}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 mt-0.5">
                  <span>{relativeTime(h.ts)}</span>
                  {h.useToolingApi && (
                    <span className="text-blue-400">tooling</span>
                  )}
                  {h.org && (
                    <span className="text-zinc-600 truncate" title={h.org}>
                      {h.org}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
