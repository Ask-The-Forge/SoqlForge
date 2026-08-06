/**
 * QueryEditor — CodeMirror 6 SOQL editor (minimal).
 *
 * Intentionally stripped to a small set of extensions while we hunt a
 * WebView2-renderer-freeze. Things deliberately omitted for now: autocomplete,
 * bracket matching, close brackets, search, drawSelection, indentOnInput.
 * Re-add once the baseline is verified stable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import { useAppStore } from "../../stores/appStore";
import { shortcut } from "../../lib/platform";
import { type UseQueryResult } from "../../hooks/useQuery";
import { useEditorSchema } from "../../hooks/useEditorSchema";
import { soqlLanguage } from "./soqlLanguage";
import {
  ghostPrediction,
  ghostPredictionKeymap,
} from "./ghostPrediction";
import { AiPromptBar } from "./AiPromptBar";
import { ObjectPicker } from "./ObjectPicker";

interface QueryEditorProps {
  query: UseQueryResult;
  /** Called when the user wants to jump to Settings (e.g. AI bar with no key). */
  onOpenSettings: () => void;
}

/** Self-contained 10 Hz elapsed display. Lives in its own component so the
 *  ticking re-renders stay local instead of churning the zustand store (and
 *  its localStorage persistence) on every tick. `startedAt` comes from the
 *  tab, so switching tabs mid-run neither freezes nor resets the clock. */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="text-xs font-mono text-blue-400 tabular-nums">
      {(Math.max(0, now - startedAt) / 1000).toFixed(1)}s
    </span>
  );
}

// Dark-mode highlight palette — vibrant colors against the zinc-950 background.
const soqlHighlightDark = HighlightStyle.define([
  { tag: t.keyword, color: "#7dd3fc", fontWeight: "600" },
  { tag: t.function(t.variableName), color: "#fbbf24" },
  { tag: t.atom, color: "#c084fc" },
  { tag: t.string, color: "#86efac" },
  { tag: t.number, color: "#fda4af" },
  { tag: t.comment, color: "#71717a", fontStyle: "italic" },
  { tag: t.operator, color: "#a1a1aa" },
  { tag: t.punctuation, color: "#a1a1aa" },
  { tag: t.variableName, color: "#e4e4e7" },
]);

// Light-mode highlight palette — same hue families but pushed to the dark end
// of the Tailwind ramp so they stay legible against white.
const soqlHighlightLight = HighlightStyle.define([
  { tag: t.keyword, color: "#0369a1", fontWeight: "600" },
  { tag: t.function(t.variableName), color: "#b45309" },
  { tag: t.atom, color: "#7e22ce" },
  { tag: t.string, color: "#15803d" },
  { tag: t.number, color: "#be123c" },
  { tag: t.comment, color: "#71717a", fontStyle: "italic" },
  { tag: t.operator, color: "#52525b" },
  { tag: t.punctuation, color: "#52525b" },
  { tag: t.variableName, color: "#18181b" },
]);

const editorThemeDark = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#0e1116", color: "#e4e4e7" },
    ".cm-scroller": {
      fontFamily:
        'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      lineHeight: "1.5",
    },
    ".cm-content": { caretColor: "#60a5fa" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "#0e1116",
      color: "#52525b",
      border: "none",
    },
  },
  { dark: true },
);

const editorThemeLight = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#ffffff", color: "#18181b" },
    ".cm-scroller": {
      fontFamily:
        'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      lineHeight: "1.5",
    },
    ".cm-content": { caretColor: "#2563eb" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "#fafafa",
      color: "#a1a1aa",
      border: "none",
    },
  },
  { dark: false },
);

export function QueryEditor({ query, onOpenSettings }: QueryEditorProps) {
  const activeOrg = useAppStore((s) => s.activeOrg);
  const fontSize = useAppStore((s) => s.fontSize);
  const theme = useAppStore((s) => s.theme);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [height, setHeight] = useState(220);
  const [aiOpen, setAiOpen] = useState(false);

  // Keep the schema cache in sync with the FROM-object in the editor.
  useEditorSchema(query.text, activeOrg);

  // Keep refs to the latest props so the keymap captured at mount always sees
  // fresh state without rebuilding the editor.
  const runRef = useRef(query.run);
  const setTextRef = useRef(query.setText);
  useEffect(() => {
    runRef.current = query.run;
    setTextRef.current = query.setText;
  }, [query.run, query.setText]);

  const runFromKeymap = useCallback(() => {
    void runRef.current();
    return true;
  }, []);

  const fontSizeCompartment = useMemo(() => new Compartment(), []);
  const themeCompartment = useMemo(() => new Compartment(), []);
  const highlightCompartment = useMemo(() => new Compartment(), []);

  // Mount the editor ONCE.
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: query.text,
      extensions: [
        lineNumbers(),
        history(),
        highlightCompartment.of(
          syntaxHighlighting(
            theme === "light" ? soqlHighlightLight : soqlHighlightDark,
          ),
        ),
        soqlLanguage(),
        // ghostPrediction's StateField + ghost-text decoration
        ...ghostPrediction,
        // Tab handler must come BEFORE defaultKeymap so it gets first crack
        // at the Tab key; falls through (returns false) when there's no
        // ghost to accept.
        keymap.of([
          { key: "Ctrl-Enter", run: runFromKeymap, preventDefault: true },
          { key: "Cmd-Enter", run: runFromKeymap, preventDefault: true },
          { key: "F5", run: runFromKeymap, preventDefault: true },
          ...ghostPredictionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        themeCompartment.of(
          theme === "light" ? editorThemeLight : editorThemeDark,
        ),
        fontSizeCompartment.of(
          EditorView.theme({
            ".cm-content": { fontSize: `${fontSize}px` },
            ".cm-gutters": { fontSize: `${fontSize}px` },
          }),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setTextRef.current(u.state.doc.toString());
          }
        }),
      ],
    });
    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });
    // Dev: expose the view on `window.__cmView` for debug / CDP eval poking.
    if (typeof window !== "undefined") {
      (window as unknown as { __cmView: EditorView }).__cmView = viewRef.current;
    }
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external text changes into the editor (e.g. history pick).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === query.text) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: query.text },
    });
  }, [query.text]);

  // Reconfigure font-size when it changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontSizeCompartment.reconfigure(
        EditorView.theme({
          ".cm-content": { fontSize: `${fontSize}px` },
          ".cm-gutters": { fontSize: `${fontSize}px` },
        }),
      ),
    });
  }, [fontSize, fontSizeCompartment]);

  // Swap the editor theme + highlight palette when the app theme changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        themeCompartment.reconfigure(
          theme === "light" ? editorThemeLight : editorThemeDark,
        ),
        highlightCompartment.reconfigure(
          syntaxHighlighting(
            theme === "light" ? soqlHighlightLight : soqlHighlightDark,
          ),
        ),
      ],
    });
  }, [theme, themeCompartment, highlightCompartment]);

  // Drag-to-resize the editor height.
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: height };
    document.body.style.cursor = "row-resize";

    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientY - dragRef.current.startY;
      setHeight(Math.max(120, dragRef.current.startH + delta));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const noOrg = !activeOrg;

  return (
    <div className="flex flex-col border-b border-zinc-800">
      <div className="flex items-center gap-3 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800">
        <button
          onClick={() => void query.run()}
          disabled={query.isRunning || noOrg}
          className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium"
          title={noOrg ? "Select an org first" : `Run (${shortcut("Enter")})`}
        >
          {query.isRunning ? "Running…" : "Run"}
        </button>

        {query.isRunning && (
          <button
            onClick={() => query.cancel()}
            className="px-2 py-1 text-xs rounded border border-red-800 text-red-300 hover:border-red-500 hover:text-red-100"
            title="Cancel the running query (kills the sf subprocess)"
          >
            Cancel
          </button>
        )}

        {query.isRunning && query.runStartedAt != null && (
          <ElapsedTimer startedAt={query.runStartedAt} />
        )}

        <ObjectPicker
          onPick={(soql) => {
            query.setText(soql);
            const view = viewRef.current;
            if (view) {
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: soql },
                selection: { anchor: soql.length },
              });
              view.focus();
            }
          }}
        />

        <button
          onClick={() => setAiOpen((v) => !v)}
          className={
            "text-xs border rounded px-2 py-0.5 " +
            (aiOpen
              ? "bg-blue-600 border-blue-500 text-white"
              : "text-zinc-300 border-zinc-700 hover:border-zinc-500 hover:text-zinc-100")
          }
          title="Generate a SOQL query from a natural-language description (configure in Settings)"
        >
          ✨ AI
        </button>

        <label
          className="flex items-center gap-1.5 text-xs text-zinc-300 select-none cursor-pointer"
          title="Use the Tooling API instead of the standard SOQL endpoint. Required for metadata-backed objects (ApexClass, CustomField, …)."
        >
          <input
            type="checkbox"
            checked={query.useToolingApi}
            onChange={(e) => query.setUseToolingApi(e.target.checked)}
            className="accent-blue-600"
          />
          Tooling
        </label>

        <label
          className="flex items-center gap-1.5 text-xs text-zinc-300 select-none cursor-pointer"
          title="Run via the Bulk API. Required for results above ~50k records, strongly recommended above 2k. Waits up to 10 minutes for the job to complete."
        >
          <input
            type="checkbox"
            checked={query.useBulkApi}
            onChange={(e) => query.setUseBulkApi(e.target.checked)}
            className="accent-blue-600"
          />
          Bulk
        </label>

        <label
          className="flex items-center gap-1.5 text-xs text-zinc-300 select-none cursor-pointer"
          title="Include soft-deleted and archived records (queryAll endpoint)."
        >
          <input
            type="checkbox"
            checked={query.allRows}
            onChange={(e) => query.setAllRows(e.target.checked)}
            className="accent-blue-600"
          />
          All Rows
        </label>

        <div className="ml-auto text-xs text-zinc-500">
          {shortcut("Enter")} to run
        </div>
      </div>

      <AiPromptBar
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onOpenSettings={() => {
          setAiOpen(false);
          onOpenSettings();
        }}
        onGenerate={(soql) => {
          query.setText(soql);
          // Also push the new text directly into the editor view so the user
          // sees the change immediately even before the React state cycle
          // completes (the text-sync useEffect handles it on the next tick,
          // but doing it here gives instant feedback).
          const view = viewRef.current;
          if (view) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: soql },
              selection: { anchor: soql.length },
            });
          }
          setAiOpen(false);
        }}
      />

      <div ref={containerRef} style={{ height }} className="overflow-hidden" />

      <div
        onMouseDown={onDragStart}
        className="h-1 bg-zinc-800 hover:bg-blue-600 cursor-row-resize transition-colors"
        title="Drag to resize"
      />

      {noOrg ? (
        <div className="px-3 py-2 text-xs text-amber-400 bg-amber-900/20 border-t border-amber-900/40">
          Select an org above to run queries.
        </div>
      ) : query.error ? (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-950/40 border-t border-red-900/50 font-mono whitespace-pre-wrap break-words">
          <span className="font-sans text-red-400 mr-2">[{query.error.code}]</span>
          {query.error.message}
        </div>
      ) : null}
    </div>
  );
}
