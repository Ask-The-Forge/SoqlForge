/**
 * App shell — layout: top-left org picker + history sidebar, main pane with
 * query editor stacked above results grid, status bar at bottom.
 */

import { useEffect, useState } from "react";
import { OrgPicker } from "./components/OrgPicker/OrgPicker";
import { QueryEditor } from "./components/QueryEditor/QueryEditor";
import { ResultsGrid } from "./components/ResultsGrid/ResultsGrid";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { HistoryList } from "./components/HistoryList/HistoryList";
import { SavedQueriesList } from "./components/SavedQueriesList/SavedQueriesList";
import { SettingsPanel } from "./components/SettingsPanel/SettingsPanel";
import { OrgManagerPanel } from "./components/OrgManager/OrgManagerPanel";
import { TabBar } from "./components/TabBar/TabBar";
import { useQuery } from "./hooks/useQuery";
import { useAppStore } from "./stores/appStore";
import "./App.css";

function App() {
  const query = useQuery();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [orgManagerOpen, setOrgManagerOpen] = useState(false);
  const theme = useAppStore((s) => s.theme);

  // Reflect the store's theme into a class on <html>. Light mode rules in
  // App.css key off `html.theme-light`.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light");
    root.classList.add(theme === "light" ? "theme-light" : "theme-dark");
  }, [theme]);

  // Window-level shortcuts: Ctrl+, opens settings; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((s) => !s);
      } else if (e.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="text-sm font-semibold tracking-tight">
          <span className="text-blue-400">Soql</span>Forge
        </div>
        <button
          onClick={() => setOrgManagerOpen(true)}
          className="ml-auto text-xs text-zinc-400 hover:text-zinc-100"
          title="Manage orgs, scratch orgs, and packages"
        >
          🗂 Orgs
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="ml-4 text-xs text-zinc-400 hover:text-zinc-100"
          title="Settings (Ctrl+,)"
        >
          ⚙ Settings
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-64 flex flex-col border-r border-zinc-800 bg-zinc-950">
          <OrgPicker />
          {/* Saved queries: top half of the remaining space, fixed-height
              scrollable. History: bottom half, also scrollable. */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="basis-1/2 min-h-0">
              <SavedQueriesList
                currentQuery={query.text}
                useToolingApi={query.useToolingApi}
                useBulkApi={query.useBulkApi}
                allRows={query.allRows}
                onLoad={(q) => {
                  query.setText(q.query);
                  query.setUseToolingApi(q.useToolingApi);
                  query.setUseBulkApi(q.useBulkApi);
                  query.setAllRows(q.allRows);
                }}
              />
            </div>
            <div className="basis-1/2 min-h-0">
              <HistoryList
                onPick={(q, tooling) => {
                  query.setText(q);
                  query.setUseToolingApi(tooling);
                }}
              />
            </div>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <TabBar />
          <QueryEditor
            query={query}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <ResultsGrid
            result={query.result}
            lastRanQuery={query.lastRanQuery}
            resultContext={query.resultContext}
          />
        </main>
      </div>

      <StatusBar result={query.result} isRunning={query.isRunning} />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <OrgManagerPanel
        open={orgManagerOpen}
        onClose={() => setOrgManagerOpen(false)}
      />
    </div>
  );
}

export default App;
