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

/** Provenance of a query result — captured when the run completes so the
 *  edit path targets what actually produced the rows, not whatever the
 *  editor text says now. */
export interface ResultContext {
  org: string;
  objectName: string | null;
  useToolingApi: boolean;
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

      history: [],
      pushHistory: (entry) =>
        set((s) => {
          const prev = s.history[0];
          if (
            prev &&
            prev.query === entry.query &&
            prev.useToolingApi === entry.useToolingApi
          ) {
            return { history: [{ ...prev, ts: entry.ts }, ...s.history.slice(1)] };
          }
          return { history: [entry, ...s.history].slice(0, HISTORY_LIMIT) };
        }),
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
            ? incoming.history
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
