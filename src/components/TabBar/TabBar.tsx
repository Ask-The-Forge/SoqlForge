/**
 * TabBar — horizontal list of editor tabs above the main pane.
 *
 * Each tab shows its name (auto-derived from FROM-object on first run, or
 * user-renamed) with a small × revealed on hover. Click switches; the +
 * button at the end opens a new blank tab. Middle-click closes (handy on
 * laptops with a working middle button).
 *
 * Double-click a tab's name to rename via prompt.
 */

import { useAppStore, type Tab } from "../../stores/appStore";
import { extractFromObject } from "../../lib/schemaCache";

function deriveDisplayName(tab: Tab): string {
  if (tab.name && tab.name !== "Untitled") return tab.name;
  // Depth-aware FROM extraction — a leading subquery must not name the tab
  // after the child relationship.
  const from = extractFromObject(tab.text);
  if (from) return from;
  return "Untitled";
}

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const addTab = useAppStore((s) => s.addTab);

  return (
    <div className="flex items-stretch bg-zinc-900 border-b border-zinc-800 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // eslint-disable-next-line no-alert
              const next = window.prompt("Rename tab:", deriveDisplayName(t));
              if (next != null && next.trim()) renameTab(t.id, next.trim());
            }}
            className={
              "group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-r border-zinc-800 select-none whitespace-nowrap " +
              (active
                ? "bg-zinc-950 text-zinc-100 border-b-2 border-b-blue-500"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200")
            }
            title={`${deriveDisplayName(t)} — middle-click or × to close, double-click to rename`}
          >
            <span className="truncate max-w-[18ch]">
              {deriveDisplayName(t)}
            </span>
            {t.isRunning && (
              <span className="text-blue-400 animate-pulse">•</span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              className={
                "leading-none text-zinc-500 hover:text-red-400 " +
                (active
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-70 hover:!opacity-100")
              }
              aria-label="Close tab"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        onClick={() => addTab()}
        className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50"
        title="New tab"
      >
        +
      </button>
    </div>
  );
}
