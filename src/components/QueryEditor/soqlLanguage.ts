/**
 * SOQL language for CodeMirror 6.
 *
 * Two layers:
 *   1. A StreamLanguage tokenizer for syntax highlighting (keyword/string/
 *      number/identifier).
 *   2. A completion source that walks a small SOQL state machine
 *      (see soqlContext.ts) and picks a different pool of suggestions per
 *      cursor position:
 *
 *        initial            → SELECT keyword only
 *        select-field       → fields + FIELDS(ALL) + aggregate functions
 *        select-named       → FROM keyword (top) + more fields
 *        from-object        → SObject names
 *        post-from          → WHERE/ORDER/GROUP/LIMIT/HAVING/FOR/WITH/BY
 *        where-field        → fields + NOT
 *        where-operator     → IN/LIKE/NOT/INCLUDES/EXCLUDES
 *        where-value        → date literals + NULL/TRUE/FALSE + fields
 *        post-where-value   → AND/OR/ORDER/GROUP/LIMIT/HAVING
 *        order-field        → fields
 *        order-direction    → ASC/DESC/NULLS/FIRST/LAST/LIMIT/OFFSET
 *        general            → balanced fallback
 *
 * Within a pool we score with a fuzzy matcher (prefix > word-boundary >
 * substring > camel-case acronym) so "Las"/"Modified"/"Date"/"LMD" all
 * surface LastModifiedDate when the context is appropriate.
 */

import { StreamLanguage, LanguageSupport } from "@codemirror/language";
import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

import {
  getCurrentFields,
  getCurrentObject,
  getCurrentObjects,
  getCurrentOrg,
  getFieldsForChildRelationship,
  loadFieldsForRelationship,
  resolveChildRelationship,
} from "../../lib/schemaCache";
import type { FieldInfo } from "../../lib/tauriClient";
import {
  detectContext,
  detectSubqueryAtCursor,
  type ContextKind,
} from "./soqlContext";

// Tokenizer-only keyword sets (highlighting). Pool selection lives below.
const KEYWORDS_HIGHLIGHT = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "LIKE",
  "INCLUDES", "EXCLUDES", "ORDER", "BY", "ASC", "DESC", "NULLS",
  "FIRST", "LAST", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "TYPEOF", "WHEN", "THEN", "ELSE", "END",
  "WITH", "SECURITY_ENFORCED",
  "FOR", "UPDATE", "VIEW", "REFERENCE", "INTO", "ON",
  "FIELDS", "ALL", "STANDARD", "CUSTOM",
]);

const FUNCTIONS_HIGHLIGHT = new Set([
  "COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX",
  "CALENDAR_MONTH", "CALENDAR_QUARTER", "CALENDAR_YEAR",
  "DAY_IN_MONTH", "DAY_IN_WEEK", "DAY_IN_YEAR", "DAY_ONLY",
  "FISCAL_MONTH", "FISCAL_QUARTER", "FISCAL_YEAR", "HOUR_IN_DAY",
  "WEEK_IN_MONTH", "WEEK_IN_YEAR", "CONVERT_TIMEZONE", "FORMAT",
  "TOLABEL", "DISTANCE", "GEOLOCATION",
]);

const DATE_LITERALS_HIGHLIGHT = new Set([
  "YESTERDAY", "TODAY", "TOMORROW", "LAST_WEEK", "THIS_WEEK", "NEXT_WEEK",
  "LAST_MONTH", "THIS_MONTH", "NEXT_MONTH", "LAST_90_DAYS", "NEXT_90_DAYS",
  "LAST_N_DAYS", "NEXT_N_DAYS", "THIS_QUARTER", "LAST_QUARTER", "NEXT_QUARTER",
  "THIS_YEAR", "LAST_YEAR", "NEXT_YEAR", "THIS_FISCAL_QUARTER",
  "LAST_FISCAL_QUARTER", "NEXT_FISCAL_QUARTER", "THIS_FISCAL_YEAR",
  "LAST_FISCAL_YEAR", "NEXT_FISCAL_YEAR",
]);

const soqlStreamParser = StreamLanguage.define({
  name: "soql",
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/.*?\*\//)) {
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }
    if (stream.eatSpace()) return null;

    if (stream.match("--") || stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }
    const ch = stream.peek();
    if (ch === "'" || ch === '"') {
      stream.next();
      let escaped = false;
      let next: string | void;
      while ((next = stream.next()) !== undefined) {
        if (next === ch && !escaped) break;
        escaped = !escaped && next === "\\";
      }
      return "string";
    }
    if (stream.match(/^\d+(\.\d+)?/)) {
      return "number";
    }
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_.]*/)) {
      const word = stream.current().toUpperCase();
      if (KEYWORDS_HIGHLIGHT.has(word)) return "keyword";
      if (FUNCTIONS_HIGHLIGHT.has(word)) return "function";
      if (DATE_LITERALS_HIGHLIGHT.has(word)) return "atom";
      return "variableName";
    }
    if (stream.match(/^[=!<>]+/)) return "operator";
    if (stream.match(/^[(),]/)) return "punctuation";

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "--", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "'", '"'] },
    autocomplete: soqlCompletion,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Completion option helpers
// ─────────────────────────────────────────────────────────────────────────────

function kw(label: string, boost: number, apply?: string): Completion {
  return apply
    ? { label, type: "keyword", boost, apply }
    : { label, type: "keyword", boost };
}

function fn(label: string, boost = 4): Completion {
  return { label, type: "function", apply: `${label}()`, boost };
}

function constant(label: string, boost = 3): Completion {
  return { label, type: "constant", boost };
}

// Pre-built static option arrays — reused across calls.
const AGGREGATE_FN_OPTIONS: Completion[] = [
  fn("COUNT", 8),
  fn("COUNT_DISTINCT", 6),
  fn("SUM", 6),
  fn("AVG", 6),
  fn("MIN", 6),
  fn("MAX", 6),
];

const DATE_FN_OPTIONS: Completion[] = [
  fn("CALENDAR_YEAR", 4),
  fn("CALENDAR_QUARTER", 4),
  fn("CALENDAR_MONTH", 4),
  fn("DAY_ONLY", 4),
  fn("FISCAL_YEAR", 3),
  fn("FISCAL_QUARTER", 3),
  fn("HOUR_IN_DAY", 3),
  fn("CONVERT_TIMEZONE", 3),
  fn("FORMAT", 3),
];

const DATE_LITERAL_OPTIONS: Completion[] = Array.from(
  DATE_LITERALS_HIGHLIGHT,
).map((l) => constant(l, 5));

// ─────────────────────────────────────────────────────────────────────────────
// Per-context pool builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve cursor scope — picks the right "current object + fields" depending
 * on whether the cursor sits inside a `(SELECT … FROM <rel>)` subquery.
 *
 *   Outside any subquery → outer FROM-object + its fields
 *   Inside one          → resolved child SObject + its fields (loaded lazily
 *                          via the child-relationship cache on the outer obj)
 */
interface CursorScope {
  /** The effective SObject name for completion at the cursor. */
  object: string | null;
  /** Fields available at the cursor — may be empty if a load is still in flight. */
  fields: FieldInfo[];
}

function cursorScope(fullText: string, cursorPos: number): CursorScope {
  const sub = detectSubqueryAtCursor(fullText, cursorPos);
  if (!sub) {
    return { object: getCurrentObject(), fields: getCurrentFields() };
  }
  const org = getCurrentOrg();
  const outerObj = getCurrentObject();
  if (!org || !outerObj) return { object: null, fields: [] };
  // Side-effect: kicks off loads for parent's describe + child target.
  const fields = getFieldsForChildRelationship(
    org,
    outerObj,
    sub.childRelName,
  );
  const target = resolveChildRelationship(org, outerObj, sub.childRelName);
  return { object: target, fields };
}

function poolFor(
  ctx: ContextKind,
  fullText: string,
  cursorPos: number,
): Completion[] {
  const scope = cursorScope(fullText, cursorPos);
  const fields = scope.fields;
  const objects = getCurrentObjects();

  const fieldOpts = (boost: number): Completion[] =>
    fields.map((f) => ({
      label: f.name,
      type: "property",
      detail: f.fieldType,
      boost,
    }));

  const objectOpts = (boost = 10): Completion[] =>
    objects.map((o) => ({
      label: o.name,
      type: "class",
      detail: o.custom ? "custom" : "standard",
      boost: o.custom ? boost - 2 : boost,
    }));

  switch (ctx) {
    case "initial":
      // Only one sensible start to a SOQL query.
      return [kw("SELECT", 30)];

    case "select-field":
      // After SELECT or comma — expect a field. FIELDS(ALL) and aggregates
      // are also reasonable.
      return [
        ...fieldOpts(15),
        kw("FIELDS", 6, "FIELDS()"),
        ...AGGREGATE_FN_OPTIONS,
        kw("TYPEOF", 4),
      ];

    case "select-named":
      // After a field identifier in SELECT — FROM is by far the most likely
      // next token, but the user might also want more fields (forgetting a
      // comma is common while iterating).
      return [
        kw("FROM", 30),
        ...fieldOpts(8),
      ];

    case "from-object":
      // Pure SObject context.
      return objectOpts();

    case "post-from":
      // After "FROM <Object>" or after a complete clause — clause keywords.
      return [
        kw("WHERE", 30),
        kw("ORDER", 18, "ORDER BY "),
        kw("GROUP", 16, "GROUP BY "),
        kw("LIMIT", 16, "LIMIT "),
        kw("HAVING", 8),
        kw("BY", 6),
        kw("FOR", 4, "FOR UPDATE"),
        kw("WITH", 4, "WITH SECURITY_ENFORCED"),
      ];

    case "where-field":
      // After WHERE/AND/OR/NOT/HAVING — expect a field name.
      return [
        ...fieldOpts(15),
        kw("NOT", 10),
      ];

    case "where-operator":
      // After a field in WHERE — the most common next tokens are = / != / <
      // etc. (which the keyword popup can't suggest because they aren't
      // word-tokens) plus a handful of keyword-style operators.
      return [
        kw("IN", 20),
        kw("LIKE", 15),
        kw("NOT", 12, "NOT IN"),
        kw("INCLUDES", 8),
        kw("EXCLUDES", 8),
      ];

    case "where-value":
      // After an operator — values. Date literals are the only thing we can
      // reliably suggest. Fields work too (cross-field comparisons).
      return [
        ...DATE_LITERAL_OPTIONS,
        kw("NULL", 12),
        kw("TRUE", 10),
        kw("FALSE", 10),
        ...DATE_FN_OPTIONS,
        ...fieldOpts(5),
      ];

    case "post-where-value":
      // After a value — continue the condition or move to the next clause.
      return [
        kw("AND", 25),
        kw("OR", 20),
        kw("ORDER", 15, "ORDER BY "),
        kw("GROUP", 12, "GROUP BY "),
        kw("LIMIT", 12, "LIMIT "),
        kw("HAVING", 8),
      ];

    case "order-field":
      // After ORDER BY / GROUP BY — field name.
      return [...fieldOpts(15)];

    case "order-direction":
      // After a field in ORDER BY — direction modifiers + next clauses.
      return [
        kw("ASC", 18),
        kw("DESC", 18),
        kw("NULLS", 10, "NULLS FIRST"),
        kw("FIRST", 6),
        kw("LAST", 6),
        kw("LIMIT", 12, "LIMIT "),
        kw("OFFSET", 6),
      ];

    case "general":
    default:
      // Fallback — balanced.
      return [
        kw("SELECT", 12),
        kw("FROM", 8),
        kw("WHERE", 8),
        kw("ORDER", 6),
        kw("LIMIT", 6),
        ...fieldOpts(4),
        ...objectOpts(3),
      ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy scoring
// ─────────────────────────────────────────────────────────────────────────────

function fuzzyScore(candidate: string, query: string): number | null {
  if (!query) return 0;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();

  if (c.startsWith(q)) return 1000 - (candidate.length - query.length);

  const idx = c.indexOf(q);
  if (idx >= 0) {
    const prev = candidate[idx - 1];
    const here = candidate[idx];
    const isBoundary =
      idx === 0 ||
      prev === "_" ||
      prev === "." ||
      (here && here >= "A" && here <= "Z");
    return (isBoundary ? 500 : 200) - idx;
  }

  // Camel-case acronym match.
  let qi = 0;
  let lastIdx = -1;
  for (let i = 0; i < candidate.length && qi < q.length; i++) {
    const ch = candidate[i];
    const isUpper = ch >= "A" && ch <= "Z";
    const isStart = i === 0 || candidate[i - 1] === "_" || candidate[i - 1] === ".";
    if ((isUpper || isStart) && ch.toLowerCase() === q[qi]) {
      qi++;
      lastIdx = i;
    }
  }
  if (qi === q.length) return 100 - lastIdx;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If `beforeWord` ends with a dotted-identifier chain followed by a dot,
 * return that chain as a list of segments. Otherwise null.
 *
 * Used to switch the completion source into relationship-traversal mode:
 *   "SELECT Opportunity." → ["Opportunity"]
 *   "SELECT Opportunity.Account." → ["Opportunity", "Account"]
 */
function extractDotPath(beforeWord: string): string[] | null {
  // No trailing whitespace allowed — the dot must be the LAST char.
  const m = beforeWord.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.$/);
  if (!m) return null;
  return m[1].split(".");
}

async function soqlCompletion(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // matchBefore returns null when the cursor isn't directly after a word char.
  // For dot-traversal (`Opportunity.<cursor>`) we want to trigger with a
  // zero-width word at the cursor — handle that case explicitly.
  const beforeCursor = context.state.doc.sliceString(0, context.pos);
  const justAfterDot = beforeCursor.endsWith(".");

  let word = context.matchBefore(/[a-zA-Z_][\w]*/);
  if (!word && justAfterDot) {
    word = { from: context.pos, to: context.pos, text: "" };
  }
  if (!word) return null;
  if (word.from === word.to && !context.explicit && !justAfterDot) return null;

  const query = word.text;
  const beforeWord = context.state.doc.sliceString(0, word.from);

  // Dot-traversal takes priority over normal context detection. If we're
  // immediately after `<rel>(.<rel>)*\.` then suggest the target object's
  // fields, regardless of which SOQL clause we're in.
  const fullText = context.state.doc.toString();

  let pool: Completion[];
  const dotPath = extractDotPath(beforeWord);
  if (dotPath && dotPath.length > 0) {
    const org = getCurrentOrg();
    // The root for dot-traversal is the scope's effective object — inside a
    // subquery that's the child SObject, outside it's the active FROM.
    const scope = cursorScope(fullText, context.pos);
    const root = scope.object;
    if (org && root) {
      // Awaits the schema describe for the target object if not yet cached.
      const relFields = await loadFieldsForRelationship(org, root, dotPath);
      pool = relFields.map((f) => ({
        label: f.name,
        type: "property",
        detail: f.fieldType,
        boost: 15,
      }));
    } else {
      pool = [];
    }
  } else {
    const ctx = detectContext(beforeWord);
    pool = poolFor(ctx, fullText, context.pos);
  }

  // Filter + score. CodeMirror's default filter is prefix-favoring; ours
  // surfaces substring + word-boundary + camel-case matches too.
  type Scored = { opt: Completion; score: number };
  const scored: Scored[] = [];
  for (const opt of pool) {
    const s = fuzzyScore(opt.label, query);
    if (s == null) continue;
    scored.push({ opt, score: s + (opt.boost ?? 0) * 10 });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 50).map((s) => s.opt);
  if (top.length === 0) return null;

  return {
    from: word.from,
    options: top,
    filter: false,
    validFor: /^[\w]*$/,
  };
}

/**
 * CodeMirror's autocomplete auto-activates only when a word character is
 * typed. Typing "." doesn't trigger it — which is exactly when we DO want
 * the popup (relationship traversal: `Opportunity.<cursor>` should show
 * Opportunity's fields). This listener watches for a single-character dot
 * insertion and force-triggers completion.
 */
const dotTriggersCompletion = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  let dotInserted = false;
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.length === 1 && inserted.sliceString(0) === ".") {
      dotInserted = true;
    }
  });
  if (!dotInserted) return;
  // Defer to the next animation frame so the doc + selection are fully
  // committed before we ask for completions.
  requestAnimationFrame(() => startCompletion(update.view));
});

export function soqlLanguage(): LanguageSupport {
  return new LanguageSupport(soqlStreamParser, [
    autocompletion({
      override: [soqlCompletion],
      activateOnTyping: true,
    }),
    dotTriggersCompletion,
  ]);
}
