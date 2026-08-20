/**
 * useQuery — query state for the currently-active tab.
 *
 * Reads/writes the active tab's fields through Zustand. With tabs, "run a
 * query" now lives per-tab: each tab has its own text, toggles, result,
 * isRunning state.
 *
 * Run discipline (the important part):
 *   - `run()` reads the tab from `useAppStore.getState()` at invocation time,
 *     never from the render closure — a run triggered immediately after a
 *     text change must see the new text.
 *   - Double-run guard: a tab that is already running ignores further runs
 *     (the keyboard shortcut isn't disabled the way the button is).
 *   - Org provenance: the org captured at run start is compared against the
 *     active org when the result lands; results from a previous org are
 *     dropped instead of rendering under the wrong org. The result also
 *     carries a `resultContext` (org + FROM-object) so the inline-edit path
 *     targets what actually produced the rows.
 *   - Cancellation: every run gets a fresh runId; `cancel()` kills the sf
 *     subprocess tree and the pending promise rejects with CANCELLED, which
 *     we swallow (keep the previous result, no error banner).
 *
 * If you need to operate on a non-active tab, use `useAppStore` directly with
 * the tab id and call `updateTab` — this hook always targets the active one
 * because that's what every UI control in the editor pane is bound to.
 */

import { useCallback, useEffect } from "react";
import { cancelRun, runSoql, toAppError } from "../lib/tauriClient";
import type { AppError, QueryResult } from "../lib/tauriClient";
import {
  countPendingEdits,
  useAppStore,
  type ResultContext,
} from "../stores/appStore";
import { extractFromObject } from "../lib/schemaCache";

export interface UseQueryResult {
  text: string;
  setText: (s: string) => void;

  useToolingApi: boolean;
  setUseToolingApi: (b: boolean) => void;
  useBulkApi: boolean;
  setUseBulkApi: (b: boolean) => void;
  allRows: boolean;
  setAllRows: (b: boolean) => void;

  isRunning: boolean;
  /** Epoch ms when the in-flight run started; null when idle. */
  runStartedAt: number | null;
  error: AppError | null;
  result: QueryResult | null;
  lastRanQuery: string | null;
  resultContext: ResultContext | null;

  run: () => Promise<void>;
  /** Cancel the active tab's in-flight run (no-op when idle). */
  cancel: () => void;
}

/** Bare `SELECT COUNT() FROM X` returns totalSize but zero records via REST,
 *  which used to render as "Query returned 0 records". Synthesize a one-row
 *  result so the count is visible in the grid (and in CSV export).
 *
 *  Exported because this is the ONLY way a raw `runSoql` response is allowed
 *  to become a tab's `result` — every producer has to normalize identically,
 *  or the grid renders one path differently from the other. The grid's
 *  "fetch all rows" re-run is the second such producer. */
export function adaptResult(res: QueryResult, query: string): QueryResult {
  if (
    res.records.length === 0 &&
    /^\s*SELECT\s+COUNT\s*\(\s*\)\s+FROM\b/i.test(query)
  ) {
    return {
      ...res,
      records: [{ expr0: res.totalSize }],
      columns: ["expr0"],
      synthesizedCount: true,
    };
  }
  return res;
}

export function useQuery(): UseQueryResult {
  const activeOrg = useAppStore((s) => s.activeOrg);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const updateTab = useAppStore((s) => s.updateTab);
  // Subscribe to the active tab specifically so we re-render when it (or its
  // contents) change.
  const tab = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId) ?? null,
  );

  // ── Per-tab setters ──────────────────────────────────────────────────────
  const setText = useCallback(
    (text: string) => updateTab(activeTabId, { text }),
    [activeTabId, updateTab],
  );
  const setUseToolingApi = useCallback(
    (useToolingApi: boolean) => updateTab(activeTabId, { useToolingApi }),
    [activeTabId, updateTab],
  );
  const setUseBulkApi = useCallback(
    (useBulkApi: boolean) => updateTab(activeTabId, { useBulkApi }),
    [activeTabId, updateTab],
  );
  const setAllRows = useCallback(
    (allRows: boolean) => updateTab(activeTabId, { allRows }),
    [activeTabId, updateTab],
  );

  // Clear results when the active org changes — they were tied to that org.
  // Hits every tab so switching orgs gives a clean slate everywhere.
  const tabs = useAppStore((s) => s.tabs);
  useEffect(() => {
    for (const t of tabs) {
      if (
        t.result ||
        t.error ||
        t.lastRanQuery ||
        t.resultContext ||
        t.pendingEdits
      ) {
        updateTab(t.id, {
          result: null,
          error: null,
          lastRanQuery: null,
          resultContext: null,
          // Staged batch edits target records of the org we just left —
          // they can't survive the switch any more than the result can.
          pendingEdits: null,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrg]);

  const run = useCallback(async () => {
    // Read everything from the store at invocation time — render-closure
    // state can be one keystroke (or one tab switch) behind.
    const s = useAppStore.getState();
    const orgAtRun = s.activeOrg;
    const tabId = s.activeTabId;
    const tabAtRun = s.tabs.find((t) => t.id === tabId);
    if (!tabAtRun) return;
    if (tabAtRun.isRunning) return; // double-run guard (Ctrl+Enter spam)

    if (!orgAtRun) {
      updateTab(tabId, {
        error: {
          code: "CLI_ERROR",
          message: "Select an org before running a query.",
        },
      });
      return;
    }
    const trimmed = tabAtRun.text.trim();
    if (!trimmed) return;

    // Re-running replaces the result the staged batch edits point at — that
    // would silently throw away typed work. Make the user resolve them first
    // (Save all / Discard live in the results toolbar).
    const pendingCount = countPendingEdits(tabAtRun.pendingEdits);
    if (pendingCount > 0) {
      updateTab(tabId, {
        error: {
          code: "CLI_ERROR",
          message: `This tab has ${pendingCount} unsaved batch edit${
            pendingCount === 1 ? "" : "s"
          } — Save all or Discard them in the results toolbar before re-running.`,
        },
      });
      return;
    }

    const runId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `r_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    updateTab(tabId, {
      isRunning: true,
      error: null,
      runId,
      runStartedAt: Date.now(),
    });

    /** True when the active org is still the one this run started under.
     *  When it isn't, the org-change effect has already wiped results and
     *  anything we'd write would render under the wrong org. */
    const orgStillCurrent = () =>
      useAppStore.getState().activeOrg === orgAtRun;

    try {
      const res = await runSoql(
        orgAtRun,
        trimmed,
        {
          useToolingApi: tabAtRun.useToolingApi,
          useBulkApi: tabAtRun.useBulkApi,
          allRows: tabAtRun.allRows,
        },
        runId,
      );
      if (!orgStillCurrent()) {
        updateTab(tabId, { isRunning: false, runId: null, runStartedAt: null });
        return;
      }
      updateTab(tabId, {
        result: adaptResult(res, trimmed),
        lastRanQuery: trimmed,
        resultContext: {
          org: orgAtRun,
          objectName: extractFromObject(trimmed),
          useToolingApi: tabAtRun.useToolingApi,
          allRows: tabAtRun.allRows,
        },
        isRunning: false,
        runId: null,
        runStartedAt: null,
        error: null,
      });
      useAppStore.getState().pushHistory({
        query: trimmed,
        ts: Date.now(),
        useToolingApi: tabAtRun.useToolingApi,
        org: orgAtRun,
      });
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "CANCELLED" || !orgStillCurrent()) {
        // Cancelled (or org switched away): quietly stop. Keep whatever
        // result was showing before — the user asked to abort, not to lose
        // their previous rows.
        updateTab(tabId, { isRunning: false, runId: null, runStartedAt: null });
        return;
      }
      updateTab(tabId, {
        error: err,
        result: null,
        lastRanQuery: null,
        resultContext: null,
        isRunning: false,
        runId: null,
        runStartedAt: null,
      });
    }
  }, [updateTab]);

  const cancel = useCallback(() => {
    const s = useAppStore.getState();
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    if (t?.runId) {
      void cancelRun(t.runId).catch(() => {
        /* already finished — nothing to cancel */
      });
    }
  }, []);

  return {
    text: tab?.text ?? "",
    setText,
    useToolingApi: tab?.useToolingApi ?? false,
    setUseToolingApi,
    useBulkApi: tab?.useBulkApi ?? false,
    setUseBulkApi,
    allRows: tab?.allRows ?? false,
    setAllRows,
    isRunning: tab?.isRunning ?? false,
    runStartedAt: tab?.runStartedAt ?? null,
    error: tab?.error ?? null,
    result: tab?.result ?? null,
    lastRanQuery: tab?.lastRanQuery ?? null,
    resultContext: tab?.resultContext ?? null,
    run,
    cancel,
  };
}
