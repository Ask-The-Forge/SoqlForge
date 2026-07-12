/**
 * Derive column paths from a record set.
 *
 * The first record's keys give us the *base* columns (matching what the user
 * actually SELECTed), but relationship fields (e.g. `SELECT Account.Name`)
 * come back as nested objects: `{ Account: { Name: '...', attributes: {...} } }`.
 *
 * We walk one level deep on nested objects (skipping `attributes`) so the grid
 * shows columns like `Account.Name`. Deeper nesting (Account.Owner.Name) is also
 * supported recursively, bounded by a small depth limit to avoid runaway columns
 * when a record happens to hold a huge subtree.
 */

const MAX_DEPTH = 5;

/** Is `v` a subquery-result envelope ({ totalSize, done, records: [...] })?
 *  If so, we should treat the whole thing as one column instead of walking
 *  in and surfacing `.totalSize` / `.done` / `.records` as separate columns. */
function isSubqueryResult(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return Array.isArray(obj.records);
}

function walk(obj: Record<string, unknown>, prefix: string, depth: number, out: string[]) {
  if (depth > MAX_DEPTH) {
    out.push(prefix);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "attributes") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !isSubqueryResult(v) &&
      // A nested SObject — has its own attributes envelope (or at least is a plain object)
      Object.keys(v as object).some((kk) => kk !== "attributes")
    ) {
      walk(v as Record<string, unknown>, path, depth + 1, out);
    } else {
      out.push(path);
    }
  }
}

/**
 * Discover column paths. Order: first by the first record's top-level keys,
 * then by any additional paths found by walking nested SObjects in *all* records
 * (subqueries / relationship lookups can have null values in early records).
 */
export function discoverColumns(records: Record<string, unknown>[]): string[] {
  if (records.length === 0) return [];

  const seen = new Set<string>();
  const ordered: string[] = [];

  const expandRecord = (rec: Record<string, unknown>) => {
    for (const k of Object.keys(rec)) {
      if (k === "attributes") continue;
      const v = rec[k];
      // Subquery envelope → expose the column itself; the cell renderer
      // summarizes the inner records (no .totalSize / .done / .records spam).
      if (isSubqueryResult(v)) {
        if (!seen.has(k)) {
          seen.add(k);
          ordered.push(k);
        }
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested: string[] = [];
        walk(v as Record<string, unknown>, k, 1, nested);
        for (const path of nested) {
          if (!seen.has(path)) {
            seen.add(path);
            ordered.push(path);
          }
        }
      } else if (!seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }
  };

  // First record gives canonical ordering for top-level fields.
  expandRecord(records[0]);
  // Sweep remaining records for paths missed because the first record was null.
  for (let i = 1; i < records.length; i++) {
    expandRecord(records[i]);
  }

  return ordered;
}
