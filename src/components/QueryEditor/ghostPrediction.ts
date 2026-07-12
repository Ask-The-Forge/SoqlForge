/**
 * Inline "ghost text" predictions for SOQL — Copilot-style.
 *
 * We render the most-likely next chunk of the query in faint italics after
 * the cursor; pressing Tab inserts it. Designed around the observation that
 * SOQL queries follow a very tight skeleton: SELECT <fields> FROM <object>
 * (optional WHERE / ORDER BY / LIMIT). The predictor handles the few common
 * "what comes next" cases:
 *
 *   empty doc                            → "SELECT Id FROM "
 *   "Sel" / "Sele" / "Select" prefix     → "SELECT Id FROM " (rest of)
 *   "SELECT " (cursor at end)            → "Id FROM "
 *   "SELECT Id "                          → "FROM "
 *   "FROM Acc" (partial object name)     → "ount " (best object completion)
 *   "FROM Account " (no clause yet)      → "WHERE "
 *
 * Anything else: no prediction (the regular autocomplete popup handles it).
 *
 * Coexistence: the autocomplete popup still appears alongside the ghost. The
 * ghost is a hint for the obvious continuation; the popup is the chooser.
 * Tab accepts the ghost; arrow keys / Enter still drive the popup.
 */

import { EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  WidgetType,
} from "@codemirror/view";

import { getCurrentObjects } from "../../lib/schemaCache";

interface Prediction {
  /** Inclusive start of the range to replace on accept. */
  replaceFrom: number;
  /** Exclusive end of the range to replace (always == cursor). */
  replaceTo: number;
  /** Full text to insert in place of [replaceFrom, replaceTo]. */
  insert: string;
  /** Just the portion that's shown as ghost text (= insert minus what's already typed). */
  ghostText: string;
}

function mkPred(
  replaceFrom: number,
  replaceTo: number,
  insert: string,
): Prediction {
  // `ghostText` is what appears visually beyond the cursor.
  // Replacing [from, to] with insert; the cursor sits at `to`, so anything
  // past `to - from` characters of `insert` is the "new" text.
  return {
    replaceFrom,
    replaceTo,
    insert,
    ghostText: insert.slice(replaceTo - replaceFrom),
  };
}

function computePrediction(state: EditorState): Prediction | null {
  // Don't suggest when there's an active selection.
  const sel = state.selection.main;
  if (sel.from !== sel.to) return null;
  const cursor = sel.head;

  // Only predict at the end of the doc (or when only whitespace follows).
  // Predicting mid-query gets ambiguous fast — leave that to the popup.
  const after = state.doc.sliceString(cursor);
  if (/\S/.test(after)) return null;

  const before = state.doc.sliceString(0, cursor);
  const beforeTrim = before.replace(/\s+$/, "");
  const leadingWs = before.match(/^\s*/)?.[0] ?? "";

  // ── Pattern 1: empty document → full skeleton
  if (beforeTrim === "") {
    return mkPred(cursor, cursor, "SELECT Id FROM ");
  }

  // ── Pattern 2: partial SELECT at start (with optional leading whitespace)
  const selPartial = before.match(/^(\s*)(s|se|sel|sele|selec|select)$/i);
  if (selPartial) {
    return mkPred(0, cursor, leadingWs + "SELECT Id FROM ");
  }

  // ── Pattern 3: cursor right after "SELECT " → suggest "Id FROM "
  if (/(?:^|\s)select\s+$/i.test(before) && !/\bfrom\b/i.test(before)) {
    return mkPred(cursor, cursor, "Id FROM ");
  }

  // ── Pattern 4: "SELECT <field>(, <field>)* " (any number of fields) with
  //    trailing space and no FROM yet → suggest "FROM "
  if (
    /^\s*select\s+\w+(?:\s*,\s*\w+)*\s+$/i.test(before) &&
    !/\bfrom\b/i.test(before)
  ) {
    return mkPred(cursor, cursor, "FROM ");
  }

  // ── Pattern 5: completing an object name after FROM (e.g. "FROM Acc" → ount)
  const fromPartial = before.match(/\bfrom\s+(\w+)$/i);
  if (fromPartial) {
    const partial = fromPartial[1];
    const partialStart = cursor - partial.length;
    const objects = getCurrentObjects();
    const matches = objects.filter((o) =>
      o.name.toLowerCase().startsWith(partial.toLowerCase()),
    );
    if (matches.length > 0) {
      // Prefer: standard > custom, then shorter name, then alpha.
      matches.sort((a, b) => {
        if (a.custom !== b.custom) return a.custom ? 1 : -1;
        return a.name.length - b.name.length || a.name.localeCompare(b.name);
      });
      const best = matches[0];
      if (best.name.length > partial.length) {
        return mkPred(partialStart, cursor, best.name + " ");
      }
    }
  }

  // ── Pattern 6: after "FROM <Object> " with no clauses yet → "WHERE "
  if (
    /\bfrom\s+\w+\s+$/i.test(before) &&
    !/\b(where|order|group|limit|having|offset|with|for)\b/i.test(before)
  ) {
    return mkPred(cursor, cursor, "WHERE ");
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeMirror plumbing
// ─────────────────────────────────────────────────────────────────────────────

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostTextWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    return span;
  }
  // Widget is not editable — clicks fall through to the editor.
  ignoreEvent(): boolean {
    return true;
  }
}

const predictionField = StateField.define<Prediction | null>({
  create: (state) => computePrediction(state),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection) return computePrediction(tr.state);
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (pred): DecorationSet => {
      if (!pred || !pred.ghostText) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostTextWidget(pred.ghostText),
          side: 1, // place after the cursor
        }).range(pred.replaceTo),
      ]);
    }),
});

const ghostTheme = EditorView.theme({
  ".cm-ghost-text": {
    opacity: "0.5",
    fontStyle: "italic",
    color: "#6b7280", // neutral gray, readable on both themes
    pointerEvents: "none",
    userSelect: "none",
  },
});

/**
 * Tab keybinding — accepts the current ghost prediction if one exists.
 * Returns `false` when there's nothing to accept so other Tab handlers
 * (indent, focus next, default insert tab) take over normally.
 */
const acceptGhostBinding: KeyBinding = {
  key: "Tab",
  run: (view) => {
    const pred = view.state.field(predictionField, false);
    if (!pred || !pred.ghostText) return false;
    view.dispatch({
      changes: {
        from: pred.replaceFrom,
        to: pred.replaceTo,
        insert: pred.insert,
      },
      selection: { anchor: pred.replaceFrom + pred.insert.length },
      userEvent: "input.complete",
    });
    return true;
  },
};

/**
 * Escape key dismisses the ghost (handy if it's distracting). We don't
 * persist the dismissal — the next keystroke will recompute.
 *
 * Actually CodeMirror recomputes the field on every doc/selection change
 * anyway, so this is mostly cosmetic for "I see the suggestion and want
 * it gone right now". For simplicity we skip an explicit handler and rely
 * on natural recomputation.
 */

export const ghostPrediction = [
  predictionField,
  ghostTheme,
];

export const ghostPredictionKeymap: KeyBinding[] = [acceptGhostBinding];
