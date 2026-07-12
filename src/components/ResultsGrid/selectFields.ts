/**
 * Parse the SELECT clause of a SOQL query to recover the field list in the
 * order the user typed it.
 *
 * Salesforce's REST response orders record keys somewhat arbitrarily (often
 * by metadata definition order, not query order), so without this the grid
 * would show columns out of sequence relative to the SELECT statement.
 *
 * Each item resolves to a `{ key, label }` pair:
 *   - `key` is what the record actually carries the value under — the bare
 *     identifier (Id, Account.Name), an alias, or Salesforce's synthetic
 *     `expr0`/`expr1` keys for unaliased function expressions.
 *   - `label` is what the grid should show in the header — for aggregates
 *     that's the original expression text ("COUNT(Id)") instead of "expr0".
 *
 * Salesforce's exprN numbering counts only UNALIASED function expressions,
 * in SELECT order; aliased ones are keyed by their alias and don't consume
 * an index. (`SELECT Name, COUNT(Id) c, SUM(Amount) FROM … GROUP BY Name`
 * → keys: Name, c, expr0.)
 *
 * Returns an empty array if the query has no SELECT clause.
 */

export interface SelectField {
  key: string;
  label: string;
}

export function parseSelectFields(soql: string): SelectField[] {
  if (!soql) return [];

  // Strip strings, block + line comments — none of those should appear inside
  // a SELECT field list but be defensive.
  const cleaned = soql
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(--|\/\/).*$/gm, " ");

  // Find the outermost SELECT … FROM. Depth-aware to skip subqueries when
  // looking for the top-level FROM.
  const upper = cleaned.toUpperCase();
  const selectIdx = upper.search(/\bSELECT\b/);
  if (selectIdx === -1) return [];

  // Walk forward from after SELECT to find the matching top-level FROM.
  const startList = selectIdx + "SELECT".length;
  let depth = 0;
  let fromIdx = -1;
  for (let i = startList; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      i + 4 < cleaned.length &&
      upper.startsWith("FROM", i) &&
      // Word boundary: char before is whitespace/punct, char after is whitespace/punct.
      !/\w/.test(cleaned[i - 1] ?? " ") &&
      !/\w/.test(cleaned[i + 4] ?? " ")
    ) {
      fromIdx = i;
      break;
    }
  }
  if (fromIdx === -1) return [];

  const list = cleaned.slice(startList, fromIdx);

  // Split on top-level commas (depth-aware so subqueries stay intact).
  const items: string[] = [];
  let current = "";
  depth = 0;
  for (const ch of list) {
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());

  const out: SelectField[] = [];
  let exprIdx = 0;
  for (const item of items) {
    const f = normalizeFieldExpr(item, () => exprIdx++);
    if (f) out.push(f);
  }
  return out;
}

/** SOQL keywords that can directly follow the SELECT list item — never treat
 *  these as a bare alias. */
const NON_ALIAS_WORDS = new Set(["FROM", "AS"]);

function normalizeFieldExpr(
  expr: string,
  nextExprIdx: () => number,
): SelectField | null {
  const trimmed = expr.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;

  // Simple identifier or dotted path: Id, Name, Account.Name, Owner.Profile.Name
  if (/^[A-Za-z_][\w.]*$/.test(trimmed)) {
    return { key: trimmed, label: trimmed };
  }

  // Subquery: `(SELECT … FROM Quotes …)` — the response keys it under the
  // child-relationship name from the inner FROM. Emit JUST that name so the
  // grid shows one clean "Quotes" column (the cell renderer summarizes the
  // inner records).
  if (/^\(\s*SELECT\b/i.test(trimmed)) {
    const fromMatch = trimmed.match(/\bFROM\s+([A-Za-z_]\w*)/i);
    return fromMatch
      ? { key: fromMatch[1], label: fromMatch[1] }
      : null;
  }

  // FIELDS(ALL|STANDARD|CUSTOM) — expands server-side; we can't know the
  // columns here, so keep the literal (the union with backend-discovered
  // columns fills in the real ones). Checked BEFORE the generic function
  // branch so it doesn't get an exprN key.
  if (/^FIELDS\s*\(/i.test(trimmed)) {
    return { key: trimmed, label: trimmed };
  }

  // Function expression: COUNT(Id), COUNT(), MIN(Amount), FORMAT(CreatedDate),
  // possibly with an alias (`COUNT(Id) total` or `COUNT(Id) AS total`).
  const funcMatch = trimmed.match(
    /^([A-Za-z_]\w*\s*\([^)]*\))(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?$/i,
  );
  if (funcMatch) {
    const fnText = funcMatch[1].replace(/\s+/g, "");
    const alias = funcMatch[2];
    if (alias && !NON_ALIAS_WORDS.has(alias.toUpperCase())) {
      return { key: alias, label: `${fnText} ${alias}` };
    }
    return { key: `expr${nextExprIdx()}`, label: fnText };
  }

  // Plain field with alias: `Name n` / `Name AS n` (rare but legal in
  // aggregate queries).
  const aliasMatch = trimmed.match(
    /^([A-Za-z_][\w.]*)\s+(?:AS\s+)?([A-Za-z_]\w*)$/i,
  );
  if (aliasMatch && !NON_ALIAS_WORDS.has(aliasMatch[2].toUpperCase())) {
    return { key: aliasMatch[2], label: trimmed };
  }

  // TYPEOF … END and other exotic shapes — drop rather than leak ugly text
  // as a column header; backend-discovered columns still surface the data.
  return null;
}
