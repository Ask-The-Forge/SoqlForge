/**
 * StatusBar — bottom strip with active org, row count, query time.
 */

import { useAppStore } from "../../stores/appStore";
import { useUpdater } from "../../hooks/useUpdater";
import type { QueryResult } from "../../lib/tauriClient";

interface StatusBarProps {
  result: QueryResult | null;
  isRunning: boolean;
}

export function StatusBar({ result, isRunning }: StatusBarProps) {
  const activeOrg = useAppStore((s) => s.activeOrg);
  const updater = useUpdater();

  return (
    <div className="flex items-center gap-4 px-3 py-1 text-xs text-zinc-400 bg-zinc-950 border-t border-zinc-800">
      <span className="flex items-center gap-1">
        <span className="text-zinc-500">org:</span>
        <span className="text-zinc-200 font-mono">
          {activeOrg ?? "(none)"}
        </span>
      </span>
      <span className="text-zinc-700">·</span>
      <span>
        {isRunning ? (
          <span className="text-blue-400">running…</span>
        ) : result?.synthesizedCount ? (
          // Bare `SELECT COUNT()` — totalSize IS the count; "(showing 1)"
          // would just be confusing for the synthesized row.
          <>count: {result.totalSize.toLocaleString()}</>
        ) : result ? (
          <>
            {result.totalSize.toLocaleString()} row
            {result.totalSize === 1 ? "" : "s"}
            {result.records.length < result.totalSize
              ? ` (showing ${result.records.length.toLocaleString()})`
              : ""}
          </>
        ) : (
          <span className="text-zinc-600">no results</span>
        )}
      </span>
      {result && !isRunning && (
        <>
          <span className="text-zinc-700">·</span>
          <span>{result.elapsedMs.toLocaleString()} ms</span>
        </>
      )}
      {result && !result.done && (
        <>
          <span className="text-zinc-700">·</span>
          <span className="text-amber-400">truncated</span>
        </>
      )}

      {/* Update prompt — pushed to the far right. Only rendered once a newer
          signed release is found; otherwise the updater sits silent. */}
      {updater.phase !== "idle" && (
        <div className="ml-auto flex items-center gap-2">
          {updater.phase === "available" && (
            <button
              type="button"
              onClick={updater.install}
              title={updater.notes ?? undefined}
              className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
            >
              Update to {updater.version} available — install &amp; restart
            </button>
          )}
          {updater.phase === "downloading" && (
            <span className="text-blue-400">downloading update…</span>
          )}
          {updater.phase === "installed" && (
            <span className="text-emerald-400">installed — restarting…</span>
          )}
          {updater.error && (
            <span className="text-red-400" title={updater.error}>
              update failed
            </span>
          )}
        </div>
      )}
    </div>
  );
}
