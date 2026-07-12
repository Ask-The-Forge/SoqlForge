/**
 * StatusBar — bottom strip with active org, row count, query time.
 */

import { useAppStore } from "../../stores/appStore";
import type { QueryResult } from "../../lib/tauriClient";

interface StatusBarProps {
  result: QueryResult | null;
  isRunning: boolean;
}

export function StatusBar({ result, isRunning }: StatusBarProps) {
  const activeOrg = useAppStore((s) => s.activeOrg);

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
    </div>
  );
}
