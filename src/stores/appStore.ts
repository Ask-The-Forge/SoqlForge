/**
 * Global application state.
 *
 * Owns: active org, query history, saved queries, **per-tab query state**,
 * UI preferences. Components subscribe via selectors so unrelated updates
 * don't trigger re-renders elsewhere.
 *
 * Per-tab fields split into two camps:
 *   - Persisted: name, text, useToolingApi, useBulkApi, allRows. Survive a
 *     relaunch — the user expects to come back to their work in progress.
 *   - Transient: isRunning, liveElapsedMs, error, result, lastRanQuery.
 *     Reset on hydration; results don't survive close because they can be
 *     huge (50k records × any width) and re-running is cheap.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { AppError, QueryResult } from "../lib/tauriClient";

const HISTORY_LIMIT = 50;
// Saved queries are user-curated, but still cap them so a runaway scripted
// save loop can't blow the localStorage quota and take the whole persisted
// store down with it.
const SAVED_QUERIES_LIMIT = 200;

export const DEFAULT_QUERY =
  "SELECT Id, Name, CreatedDate FROM Account ORDER BY CreatedDate DESC LIMIT 100";

export interface HistoryEntry {
  query: string;
  ts: number;
  useToolingApi: boolean;
  /** Org alias the query ran against. Optional — entries from older versions
   *  of the app don't have it. */
  org?: string;
}

/** Collapse duplicate history entries, keeping the FIRST occurrence of each
 *  query (the list is newest-first, so that's the most recent run).
 *
 *  Identity is query text + API mode. Org is deliberately NOT part of the key:
 *  it's a label on the entry, not a different query, so re-running the same
 *  SOQL against another org moves the existing row instead of cloning it.
 *
 *  Runs on push and on hydration — the latter cleans up histories written by
 *  builds that only deduped against the newest entry. Tolerates junk entries
 *  from a corrupted blob by dropping them; `merge` must never throw. */
function dedupeHistory(list: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const h of list) {
    if (!h || typeof h.query !== "string") continue;
    const key = `${h.useToolingApi ? "T" : "R"}\u0000${h.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** Provenance of a query result — captured when the run completes so the
 *  edit path (and the "fetch all rows" re-run) targets what actually produced
 *  the rows, not whatever the editor text says now. */
export interface ResultContext {
  org: string;
  objectName: string | null;
  useToolingApi: boolean;
  /** queryAll (soft-deleted/archived rows included) — must match on re-run. */
  allRows: boolean;
}

/** Scalar a cell edit can produce — matches CellEditor's CommitValue and the
 *  value type `sf data update record` accepts. */
export type PendingValue = string | number | boolean | null;

/** Staged batch edits: record Id → { FieldApiName: new value }. Keyed by Id
 *  (not row index) so sorts and row deletes can't misattribute an edit. */
export type PendingEdits = Record<string, Record<string, PendingValue>>;

/** Total staged field edits across a tab's pending set. */
export function countPendingEdits(pending: PendingEdits | null | undefined): number {
  if (!pending) return 0;
  return Object.values(pending).reduce((n, fields) => n + Object.keys(fields).length, 0);
}

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  useToolingApi: boolean;
  useBulkApi: boolean;
  allRows: boolean;
  ts: number;
}

/** All state for one editor tab. */
export interface Tab {
  id: string;
  name: string;
  // ── Persisted across relaunch ────────────────────────────────────────────
  text: string;
  useToolingApi: boolean;
  useBulkApi: boolean;
  allRows: boolean;
  // ── Transient (defaulted on hydration) ───────────────────────────────────
  isRunning: boolean;
  /** Cancellation handle for the in-flight run (null when idle). */
  runId: string | null;
  /** Epoch ms when the in-flight run started — drives the elapsed display.
   *  Stored on the tab (not in a ref) so switching tabs doesn't reset it. */
  runStartedAt: number | null;
  error: AppError | null;
  result: QueryResult | null;
  lastRanQuery: string | null;
  resultContext: ResultContext | null;
  /** Batch-mode edits staged against this tab's result, not yet written to
   *  the org. Lives on the tab (not in the grid component) so switching tabs
   *  doesn't drop them. Deliberately NOT persisted — they reference records
   *  of a result that doesn't survive a relaunch either. */
  pendingEdits: PendingEdits | null;
}

interface AppState {
  activeOrg: string | null;
  setActiveOrg: (alias: string | null) => void;

  /** Bumped after any org-management mutation (login/logout/set-default/
   *  rename/delete-scratch) so `useOrgs` instances elsewhere in the tree
   *  (the sidebar picker, the Org Manager panel) know to re-fetch. Not
   *  persisted — it's a signal, not state. */
  orgsVersion: number;
  bumpOrgsVersion: () => void;

  /** alias (and username) → Lightning instance URL, synced from the org list
   *  by the OrgPicker. Lets the results grid build "open record in Salesforce"
   *  links without spawning another `sf org list`. Not persisted — cheap to
   *  re-derive once the org list loads, and results never survive a relaunch. */
  orgInstanceUrls: Record<string, string>;
  setOrgInstanceUrls: (map: Record<string, string>) => void;

  history: HistoryEntry[];
  pushHistory: (entry: HistoryEntry) => void;
  clearHistory: () => void;

  savedQueries: SavedQuery[];
  saveQuery: (entry: Omit<SavedQuery, "id" | "ts">) => void;
  renameSavedQuery: (id: string, name: string) => void;
  deleteSavedQuery: (id: string) => void;

  // ── Tabs ───────────────────────────────────────────────────────────────
  tabs: Tab[];
  activeTabId: string;
  addTab: (initial?: Partial<Tab>) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  /** Patch any subset of a tab's state. Use this from useQuery for setText/
   *  toggle setters/result updates etc. */
  updateTab: (id: string, patch: Partial<Tab>) => void;
  /** Patch a single field in a single record of the active tab's result —
   *  used by inline cell editing to reflect a successful save without
   *  re-running the query. */
  updateTabRecord: (
    tabId: string,
    rowIdx: number,
    fieldName: string,
    value: unknown,
  ) => void;
  /** Patch several fields of one record at once — the batch-save path
   *  commits a whole record's staged edits with one store write. */
  updateTabRecordFields: (
    tabId: string,
    rowIdx: number,
    values: Record<string, PendingValue>,
  ) => void;
  /** Drop a record from the active tab's result after it was deleted in the
   *  org — keeps the grid honest without forcing a re-run. */
  deleteTabRecord: (tabId: string, rowIdx: number) => void;

  // ── Batch editing ──────────────────────────────────────────────────────
  /** When true, cell edits stage into `pendingEdits` instead of writing to
   *  the org immediately; a Save all button commits them together. */
  batchEdit: boolean;
  setBatchEdit: (b: boolean) => void;
  /** Stage one field edit against a record of the tab's current result. */
  setPendingEdit: (
    tabId: string,
    recordId: string,
    field: string,
    value: PendingValue,
  ) => void;
  /** Remove staged edits at three granularities: one field (`recordId` +
   *  `field`), one record (`recordId` only), or everything (neither). */
  clearPendingEdits: (tabId: string, recordId?: string, field?: string) => void;

  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  fontSize: number;
  setFontSize: (n: number) => void;
}

function newTabId(): string {
  return `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function freshTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: overrides.id ?? newTabId(),
    name: overrides.name ?? "Untitled",
    text: overrides.text ?? DEFAULT_QUERY,
    useToolingApi: overrides.useToolingApi ?? false,
    useBulkApi: overrides.useBulkApi ?? false,
    allRows: overrides.allRows ?? false,
    isRunning: false,
    runId: null,
    runStartedAt: null,
    error: null,
    result: null,
    lastRanQuery: null,
    resultContext: null,
    pendingEdits: null,
  };
}

const initialTab = freshTab();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      activeOrg: null,
      setActiveOrg: (alias) => set({ activeOrg: alias }),

      orgsVersion: 0,
      bumpOrgsVersion: () => set((s) => ({ orgsVersion: s.orgsVersion + 1 })),

      orgInstanceUrls: {},
      setOrgInstanceUrls: (orgInstanceUrls) => set({ orgInstanceUrls }),

      history: [],
      pushHistory: (entry) =>
        // New entry goes in front and wins the dedupe, so the row carries the
        // latest run's timestamp and org wherever the query sat before.
        set((s) => ({
          history: dedupeHistory([entry, ...s.history]).slice(0, HISTORY_LIMIT),
        })),
      clearHistory: () => set({ history: [] }),

      savedQueries: [],
      saveQuery: (entry) =>
        set((s) => {
          const now = Date.now();
          const id = `q_${now}_${Math.floor(Math.random() * 1e6)}`;
          return {
            savedQueries: [{ id, ts: now, ...entry }, ...s.savedQueries].slice(
              0,
              SAVED_QUERIES_LIMIT,
            ),
          };
        }),
      renameSavedQuery: (id, name) =>
        set((s) => ({
          savedQueries: s.savedQueries.map((q) =>
            q.id === id ? { ...q, name } : q,
          ),
        })),
      deleteSavedQuery: (id) =>
        set((s) => ({
          savedQueries: s.savedQueries.filter((q) => q.id !== id),
        })),

      tabs: [initialTab],
      activeTabId: initialTab.id,
      addTab: (overrides) => {
        const tab = freshTab(overrides);
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
        return tab.id;
      },
      closeTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx === -1) return s;
          const tabs = s.tabs.filter((t) => t.id !== id);
          // Never let the user delete the last tab — keep at least one.
          if (tabs.length === 0) {
            const t = freshTab();
            return { tabs: [t], activeTabId: t.id };
          }
          // If we just closed the active one, pick the neighbor.
          const nextActive =
            s.activeTabId === id
              ? tabs[Math.min(idx, tabs.length - 1)].id
              : s.activeTabId;
          return { tabs, activeTabId: nextActive };
        }),
      setActiveTab: (id) =>
        set((s) => (s.tabs.some((t) => t.id === id) ? { activeTabId: id } : s)),
      renameTab: (id, name) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
        })),
      updateTab: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      updateTabRecord: (tabId, rowIdx, fieldName, value) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId || !t.result) return t;
            const records = t.result.records.slice();
            if (rowIdx < 0 || rowIdx >= records.length) return t;
            records[rowIdx] = { ...records[rowIdx], [fieldName]: value };
            return { ...t, result: { ...t.result, records } };
          }),
        })),
      updateTabRecordFields: (tabId, rowIdx, values) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId || !t.result) return t;
            const records = t.result.records.slice();
            if (rowIdx < 0 || rowIdx >= records.length) return t;
            records[rowIdx] = { ...records[rowIdx], ...values };
            return { ...t, result: { ...t.result, records } };
          }),
        })),
      deleteTabRecord: (tabId, rowIdx) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId || !t.result) return t;
            if (rowIdx < 0 || rowIdx >= t.result.records.length) return t;
            // A deleted record's staged batch edits die with it — they'd
            // otherwise save against a record that no longer exists.
            const deletedId = t.result.records[rowIdx]?.Id;
            let pendingEdits = t.pendingEdits;
            if (
              typeof deletedId === "string" &&
              pendingEdits &&
              deletedId in pendingEdits
            ) {
              const { [deletedId]: _dropped, ...rest } = pendingEdits;
              pendingEdits = Object.keys(rest).length ? rest : null;
            }
            const records = t.result.records.filter((_, i) => i !== rowIdx);
            return {
              ...t,
              pendingEdits,
              result: {
                ...t.result,
                records,
                // totalSize can exceed records.length (server-side paging), so
                // decrement it rather than resetting it to the array length.
                totalSize: Math.max(records.length, t.result.totalSize - 1),
              },
            };
          }),
        })),

      batchEdit: false,
      setBatchEdit: (batchEdit) => set({ batchEdit }),
      setPendingEdit: (tabId, recordId, field, value) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId) return t;
            const cur = t.pendingEdits ?? {};
            return {
              ...t,
              pendingEdits: {
                ...cur,
                [recordId]: { ...(cur[recordId] ?? {}), [field]: value },
              },
            };
          }),
        })),
      clearPendingEdits: (tabId, recordId, field) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId || !t.pendingEdits) return t;
            if (recordId === undefined) {
              return { ...t, pendingEdits: null };
            }
            const forRecord = t.pendingEdits[recordId];
            if (!forRecord) return t;
            let next: PendingEdits | null;
            if (field === undefined) {
              const { [recordId]: _record, ...rest } = t.pendingEdits;
              next = Object.keys(rest).length ? rest : null;
            } else {
              const { [field]: _field, ...restFields } = forRecord;
              if (Object.keys(restFields).length) {
                next = { ...t.pendingEdits, [recordId]: restFields };
              } else {
                const { [recordId]: _record, ...rest } = t.pendingEdits;
                next = Object.keys(rest).length ? rest : null;
              }
            }
            return { ...t, pendingEdits: next };
          }),
        })),

      theme: "dark",
      setTheme: (theme) => set({ theme }),
      fontSize: 14,
      setFontSize: (fontSize) => set({ fontSize }),
    }),
    {
      // localStorage key. Renamed from "soqlnav-app" — pre-1.0 internal,
      // accepting that existing users lose their tabs/saved/history on this
      // upgrade. (Migration would be 10 lines if that turns out to matter.)
      name: "soqlforge-app",
      version: 1,
      // Without a migrate, zustand DROPS persisted state on any version
      // mismatch (including the unversioned → v1 step). All our shape changes
      // are additive, so passing the old state through is always safe — the
      // `merge` below re-defaults anything missing.
      migrate: (persisted) => persisted as Partial<AppState>,
      storage: createJSONStorage(() => localStorage),
      // Persist tab metadata + query text + toggles, but NOT transient run
      // state (results, isRunning, etc.). On hydration any missing transient
      // fields get default values via `merge`.
      partialize: (s) => ({
        activeOrg: s.activeOrg,
        history: s.history,
        savedQueries: s.savedQueries,
        tabs: s.tabs.map(
          (t): Pick<
            Tab,
            "id" | "name" | "text" | "useToolingApi" | "useBulkApi" | "allRows"
          > => ({
            id: t.id,
            name: t.name,
            text: t.text,
            useToolingApi: t.useToolingApi,
            useBulkApi: t.useBulkApi,
            allRows: t.allRows,
          }),
        ),
        activeTabId: s.activeTabId,
        theme: s.theme,
        fontSize: s.fontSize,
        batchEdit: s.batchEdit,
      }),
      merge: (persisted, current) => {
        // Re-hydrate persisted tabs with fresh transient fields. Defensive:
        // a corrupted blob must never throw here — that would happen during
        // store creation at module import, outside the ErrorBoundary, and
        // white-screen the app. Fall back to defaults instead.
        try {
          const incoming = persisted as Partial<AppState> | undefined;
          if (!incoming || typeof incoming !== "object") return current;
          const persistedTabs = Array.isArray(incoming.tabs)
            ? incoming.tabs
            : [];
          const tabs: Tab[] = persistedTabs.length
            ? persistedTabs.map((p) =>
                freshTab(p as Partial<Tab>),
              )
            : [freshTab()];
          const activeTabId =
            incoming.activeTabId &&
            tabs.some((t) => t.id === incoming.activeTabId)
              ? incoming.activeTabId
              : tabs[0].id;
          const history = Array.isArray(incoming.history)
            ? dedupeHistory(incoming.history)
            : current.history;
          const savedQueries = Array.isArray(incoming.savedQueries)
            ? incoming.savedQueries
            : current.savedQueries;
          return {
            ...current,
            ...incoming,
            history,
            savedQueries,
            tabs,
            activeTabId,
          };
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[appStore] failed to hydrate persisted state:", e);
          return current;
        }
      },
    },
  ),
);
