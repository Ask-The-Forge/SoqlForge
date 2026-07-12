/**
 * SOQL completion-context detection.
 *
 * Tokenizes the text before the cursor and runs a small state machine over
 * the token stream. The final state tells the completion source which pool
 * of suggestions makes sense at the cursor — fields, objects, clause
 * keywords, operators, or date literals.
 *
 * Designed to be forgiving: anything unrecognized falls into "general", and
 * the completion source there mixes everything with a sensible boost order.
 */

export type ContextKind =
  | "initial" // empty doc / very start — suggest SELECT only
  | "select-field" // expect a field name (after SELECT or comma in SELECT, plus TYPEOF/CASE branches)
  | "select-named" // after a field name in SELECT — expect "," or FROM
  | "from-object" // after FROM/UPDATE/INTO — expect SObject name
  | "post-from" // after a complete FROM <Object> — expect WHERE/ORDER/GROUP/LIMIT/HAVING/FOR/WITH
  | "where-field" // after WHERE/AND/OR/NOT/HAVING — expect a field name
  | "where-operator" // after a field in WHERE — expect =, !=, IN, LIKE, …
  | "where-value" // after operator (or IN/LIKE keyword) — expect value/date literal
  | "post-where-value" // after a value — expect AND/OR or next clause keyword
  | "order-field" // after ORDER BY / GROUP BY (or comma in their lists) — expect field name
  | "order-direction" // after a field in ORDER BY — expect ASC/DESC/NULLS or comma or next clause
  | "general";

type TokenType =
  | "keyword"
  | "identifier"
  | "operator"
  | "comma"
  | "lparen"
  | "rparen"
  | "string"
  | "number"
  | "dot";

interface Token {
  type: TokenType;
  value: string;
}

const KEYWORD_SET = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "LIKE",
  "INCLUDES", "EXCLUDES", "ORDER", "BY", "ASC", "DESC", "NULLS",
  "FIRST", "LAST", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "TYPEOF", "WHEN", "THEN", "ELSE", "END",
  "WITH", "SECURITY_ENFORCED",
  "FOR", "UPDATE", "VIEW", "REFERENCE", "INTO",
  "FIELDS", "ALL", "STANDARD", "CUSTOM",
  "ON",
]);

function tokenize(input: string): Token[] {
  // Strip strings/comments so they can't accidentally produce phantom keywords.
  const cleaned = input
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(--|\/\/).*$/gm, " ");

  const tokens: Token[] = [];
  const re =
    /\s+|''|""|([A-Za-z_][\w]*)|(=|!=|<>|<=|>=|<|>)|(,)|(\()|(\))|(\.)|(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[0].trim() === "") continue;
    if (m[0] === "''" || m[0] === '""') {
      tokens.push({ type: "string", value: "" });
      continue;
    }
    if (m[1]) {
      const upper = m[1].toUpperCase();
      tokens.push({
        type: KEYWORD_SET.has(upper) ? "keyword" : "identifier",
        value: m[1],
      });
    } else if (m[2]) tokens.push({ type: "operator", value: m[2] });
    else if (m[3]) tokens.push({ type: "comma", value: "," });
    else if (m[4]) tokens.push({ type: "lparen", value: "(" });
    else if (m[5]) tokens.push({ type: "rparen", value: ")" });
    else if (m[6]) tokens.push({ type: "dot", value: "." });
    else if (m[7]) tokens.push({ type: "number", value: m[7] });
  }
  return tokens;
}

/**
 * If the cursor sits inside a `(SELECT … FROM <rel>)` subquery, return the
 * subquery's FROM-name (a child relationship on the outer object) plus the
 * prefix BEFORE the open paren (so the caller can extract the outer object).
 *
 * Takes the FULL document text + cursor offset because the subquery's FROM
 * usually appears AFTER the cursor while the user is still typing fields in
 * the SELECT list — only-text-before would miss it.
 */
export function detectSubqueryAtCursor(
  fullText: string,
  cursorPos: number,
): { openParenIdx: number; childRelName: string; outerPrefix: string } | null {
  // Strip strings so a paren inside 'foo)' doesn't confuse the counter.
  const cleaned = fullText
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));

  // Scan backward from cursor to find the innermost still-open paren.
  let depth = 0;
  let openIdx = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = cleaned[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx === -1) return null;

  // Find the matching close paren by scanning forward from the open paren.
  let closeIdx = cleaned.length;
  let d = 0;
  for (let i = openIdx + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "(") d++;
    else if (ch === ")") {
      if (d === 0) {
        closeIdx = i;
        break;
      }
      d--;
    }
  }

  // Slice the subquery body (between the parens) — may extend past cursor.
  const inside = cleaned.slice(openIdx + 1, closeIdx);
  if (!/^\s*SELECT\b/i.test(inside)) return null;

  // Subquery's FROM (anywhere in the body). User may still be typing the
  // SELECT-list with no FROM yet — in that case we can't resolve scope.
  const fromMatch = inside.match(/\bFROM\s+([A-Za-z_]\w*)/i);
  if (!fromMatch) return null;

  return {
    openParenIdx: openIdx,
    childRelName: fromMatch[1],
    outerPrefix: fullText.slice(0, openIdx),
  };
}

export function detectContext(textBeforeCursor: string): ContextKind {
  if (textBeforeCursor.trim() === "") return "initial";
  const tokens = tokenize(textBeforeCursor);
  if (tokens.length === 0) return "initial";

  let state: ContextKind = "initial";
  for (const tok of tokens) {
    state = step(state, tok);
  }
  return state;
}

function step(state: ContextKind, tok: Token): ContextKind {
  if (tok.type === "keyword") {
    const kw = tok.value.toUpperCase();
    switch (kw) {
      case "SELECT":
        return "select-field";

      case "FROM":
      case "UPDATE":
      case "INTO":
        return "from-object";

      case "WHERE":
      case "HAVING":
        return "where-field";

      // AND/OR/NOT continue a WHERE condition (or HAVING).
      case "AND":
      case "OR":
      case "NOT":
        return "where-field";

      // ORDER/GROUP partially indicate a clause; BY usually follows.
      case "ORDER":
      case "GROUP":
        return "post-from";

      case "BY":
        // After ORDER BY or GROUP BY — expect field list.
        return "order-field";

      case "ASC":
      case "DESC":
      case "NULLS":
      case "FIRST":
      case "LAST":
        return "order-direction";

      case "LIMIT":
      case "OFFSET":
        return "general"; // expects a number — no useful word-completion

      // These come AFTER a field in WHERE → expect value.
      case "IN":
      case "LIKE":
      case "INCLUDES":
      case "EXCLUDES":
        return "where-value";

      // TYPEOF starts a polymorphic block — expect a field.
      case "TYPEOF":
      case "WHEN":
      case "THEN":
      case "ELSE":
        return "select-field";
      case "END":
        return "post-from";

      // FOR UPDATE / WITH SECURITY_ENFORCED — both wrap up the query.
      case "FOR":
      case "WITH":
        return "post-from";

      // FIELDS(ALL|STANDARD|CUSTOM) — opens a function-like construct.
      case "FIELDS":
        return "select-field";

      default:
        return state;
    }
  }

  if (tok.type === "identifier") {
    switch (state) {
      case "select-field":
        return "select-named";
      case "from-object":
        return "post-from";
      case "where-field":
        return "where-operator";
      case "where-value":
        // Bareword on right side of an operator — e.g. another field.
        return "post-where-value";
      case "order-field":
        return "order-direction";
      default:
        return state;
    }
  }

  if (tok.type === "comma") {
    switch (state) {
      case "select-named":
        return "select-field";
      case "order-direction":
        return "order-field";
      case "where-value":
      case "post-where-value":
        // Comma inside an IN (...) list — keep collecting values.
        return "where-value";
      default:
        return state;
    }
  }

  if (tok.type === "operator") {
    if (state === "where-operator") return "where-value";
    return state;
  }

  if (tok.type === "string" || tok.type === "number") {
    if (state === "where-value") return "post-where-value";
    return state;
  }

  if (tok.type === "lparen") {
    // Function call or subquery. We don't try to track nesting precisely;
    // the inner content rarely changes the suggested pool meaningfully.
    return state;
  }

  if (tok.type === "rparen") {
    // Closing whatever — if we were collecting WHERE values, we're done.
    if (state === "where-value") return "post-where-value";
    return state;
  }

  if (tok.type === "dot") {
    // Relationship traversal — Account.Name. After a dot we expect another
    // identifier on the related object. We don't have related-object schema
    // yet, so route to the same field-collecting state.
    if (state === "select-named") return "select-field";
    if (state === "where-operator") return "where-field";
    if (state === "order-direction") return "order-field";
    return state;
  }

  return state;
}
