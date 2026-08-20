/**
 * Lightweight cross-component schema cache.
 *
 * Why not Zustand: this state changes on every keystroke (FROM-object parse)
 * and is read inside CodeMirror's completion source — which runs OUTSIDE the
 * React render cycle and shouldn't trigger re-renders. A tiny mutable singleton
 * fits better.
 *
 * Holds:
 *   - Per-org SObject catalog (object names for FROM autocomplete)
 *   - Per-(org, object) field lists (for SELECT/WHERE/etc. autocomplete)
 *   - Pointers to the "currently active" org and FROM-object so the completion
 *     source can read them synchronously
 *
 * Relationship traversal (typing `Opportunity.` on a Quote): we lazily fetch
 * the target SObject's describe via `loadFields`, which loads + caches
 * without touching the active-object state.
 */

import {
  describeObject,
  listObjects,
  toAppError,
  type ChildRelationshipInfo,
  type FieldInfo,
  type ObjectInfo,
  type ObjectSchema,
} from "./tauriClient";

interface SchemaState {
  currentFields: FieldInfo[];
  currentObject: string | null;
  currentOrg: string | null;
  currentObjects: ObjectInfo[];
}

const state: SchemaState = {
  currentFields: [],
  currentObject: null,
  currentOrg: null,
  currentObjects: [],
};

export function getCurrentFields(): FieldInfo[] {
  return state.currentFields;
}

export function getCurrentObject(): string | null {
  return state.currentObject;
}

export function getCurrentOrg(): string | null {
  return state.currentOrg;
}

export function getCurrentObjects(): ObjectInfo[] {
  return state.currentObjects;
}

export function clearCurrentFields(): void {
  state.currentFields = [];
  state.currentObject = null;
}

// Per-(org, object) describe cache. We store BOTH fields and child
// relationships because they come from the same `sf sobject describe` call
// and the cache miss cost is identical.
const fieldCache = new Map<string, FieldInfo[]>();
const childRelCache = new Map<string, ChildRelationshipInfo[]>();
const fieldInflight = new Map<string, Promise<ObjectSchema>>();
const fieldFailed = new Map<string, number>();

// Per-org object cache.
const objectsCache = new Map<string, ObjectInfo[]>();
const objectsInflight = new Map<string, Promise<ObjectInfo[]>>();
const objectsFailed = new Map<string, number>();

const FAILURE_BACKOFF_MS = 30_000;

function fieldKey(org: string, object: string): string {
  return `${org}::${object.toLowerCase()}`;
}

/**
 * Low-level: load + cache an object's full describe (fields + child rels).
 * Does NOT touch the active-object state — safe to call for relationship
 * traversal where the user is querying Quote but we need Opportunity's
 * fields to suggest `Opportunity.X`.
 */
async function loadObjectSchema(
  org: string,
  object: string,
): Promise<ObjectSchema> {
  const key = fieldKey(org, object);

  const cachedFields = fieldCache.get(key);
  const cachedChildRels = childRelCache.get(key);
  // Only short-circuit when BOTH parts are cached. Otherwise (e.g. cache
  // populated by an older code path that didn't store child rels) fall
  // through and re-describe to fill the gap.
  if (cachedFields && cachedChildRels) {
    return {
      fields: cachedFields,
      childRelationships: cachedChildRels,
    };
  }

  const pending = fieldInflight.get(key);
  if (pending) return pending;

  const lastFail = fieldFailed.get(key);
  if (lastFail && Date.now() - lastFail < FAILURE_BACKOFF_MS) {
    return { fields: [], childRelationships: [] };
  }

  const p = describeObject(org, object)
    .then((schema) => {
      fieldCache.set(key, schema.fields);
      childRelCache.set(key, schema.childRelationships);
      return schema;
    })
    .catch((e) => {
      fieldFailed.set(key, Date.now());
      // eslint-disable-next-line no-console
      console.warn(
        `[schemaCache] describe ${object} failed:`,
        toAppError(e).message,
      );
      return { fields: [], childRelationships: [] } as ObjectSchema;
    })
    .finally(() => {
      fieldInflight.delete(key);
    });

  fieldInflight.set(key, p);
  return p;
}

/** Loads + returns just the fields portion of an object's describe. */
export async function loadFields(
  org: string,
  object: string,
): Promise<FieldInfo[]> {
  return (await loadObjectSchema(org, object)).fields;
}

/**
 * High-level: load fields for (org, object) AND set them as the active
 * `currentFields` once they arrive (if the user is still on this object).
 * Used by useEditorSchema when it detects a new FROM-object.
 */
export async function loadFieldsFor(
  org: string,
  object: string,
): Promise<FieldInfo[]> {
  const fields = await loadFields(org, object);
  if (
    state.currentObject?.toLowerCase() === object.toLowerCase() &&
    state.currentOrg === org
  ) {
    state.currentFields = fields;
  }
  return fields;
}

/**
 * Synchronous lookup: cached fields for an object, or null if not loaded yet.
 * Used by the completion source to read related-object schemas without
 * blocking on a network round-trip.
 */
export function getCachedFields(
  org: string,
  object: string,
): FieldInfo[] | null {
  return fieldCache.get(fieldKey(org, object)) ?? null;
}

/** Synchronous lookup: cached child-relationships for an object. */
export function getCachedChildRelationships(
  org: string,
  object: string,
): ChildRelationshipInfo[] | null {
  return childRelCache.get(fieldKey(org, object)) ?? null;
}

/**
 * Resolve a subquery FROM-name (a child relationship on `parentObject`) to
 * the actual child SObject. Returns null if not cached yet, in which case
 * the caller should kick off a load.
 *
 * Example: parentObject="Account", childRelName="Contacts" → "Contact"
 */
export function resolveChildRelationship(
  org: string,
  parentObject: string,
  childRelName: string,
): string | null {
  const rels = getCachedChildRelationships(org, parentObject);
  if (!rels) return null;
  const match = rels.find(
    (r) =>
      r.relationshipName &&
      r.relationshipName.toLowerCase() === childRelName.toLowerCase(),
  );
  return match?.childSobject ?? null;
}

/**
 * Fields available for the target of a subquery FROM. Walks:
 *   parentObject's childRelationships → find childRelName → load childSObject's fields.
 *
 * Sync API: returns cached results when available; kicks off background loads
 * for anything missing so the next keystroke surfaces them.
 */
export function getFieldsForChildRelationship(
  org: string,
  parentObject: string,
  childRelName: string,
): FieldInfo[] {
  // Ensure parent's child-rel list is loaded (we need it to resolve the name).
  const rels = getCachedChildRelationships(org, parentObject);
  if (!rels) {
    void loadFields(org, parentObject);
    return [];
  }
  const target = resolveChildRelationship(org, parentObject, childRelName);
  if (!target) return [];
  const targetFields = getCachedFields(org, target);
  if (targetFields) return targetFields;
  void loadFields(org, target);
  return [];
}

/** Suffixes Salesforce puts on the companion objects it generates for you —
 *  AccountHistory, AccountShare, AccountFeed, AccountChangeEvent, and the
 *  `Foo__History` / `Foo__Share` equivalents for custom objects. They flood
 *  any prefix search and are almost never what someone is reaching for. */
const DERIVED_OBJECT_SUFFIXES = [
  "History",
  "Share",
  "Feed",
  "ChangeEvent",
  "Tag",
  "OwnerSharingRule",
  "CriteriaBasedSharingRule",
];

/** True for an auto-generated companion object. The length guard keeps a real
 *  object literally named `Tag` or `Share` out of it. Suffix matching does
 *  catch a few genuine objects (LoginHistory) — they're demoted, never
 *  hidden, which is the right trade for un-flooding every prefix search. */
export function isDerivedObject(name: string): boolean {
  return DERIVED_OBJECT_SUFFIXES.some(
    (suffix) => name.length > suffix.length && name.endsWith(suffix),
  );
}

/** How strongly to suggest an object: 2 = custom, 1 = standard, 0 = derived
 *  companion. Custom objects lead because that's what people actually query
 *  in their own org; the companions sort to the bottom regardless of whether
 *  they're custom. */
export function objectRank(o: ObjectInfo): number {
  if (isDerivedObject(o.name)) return 0;
  return o.custom ? 2 : 1;
}

/** Rank-then-alphabetical comparator, shared by every place that offers a
 *  list of objects so they all agree on what "most relevant" means. */
export function compareObjectsForSuggestion(
  a: ObjectInfo,
  b: ObjectInfo,
): number {
  const byRank = objectRank(b) - objectRank(a);
  return byRank !== 0 ? byRank : a.name.localeCompare(b.name);
}

/**
 * Given a path of relationship names rooted at `rootObject`, resolve to the
 * final target SObject name. Returns null if any segment isn't a known
 * relationship in the cache.
 *
 * Example: rootObject="Quote", path=["Opportunity"] →
 *   look up Quote's fields → find relationshipName==="Opportunity" →
 *   that field's referenceTo[0] is "Opportunity" → return "Opportunity"
 */
export function resolveRelationshipPath(
  org: string,
  rootObject: string,
  path: string[],
): string | null {
  let current = rootObject;
  for (const segment of path) {
    const fields = getCachedFields(org, current);
    if (!fields) return null;
    const rel = fields.find(
      (f) =>
        f.relationshipName &&
        f.relationshipName.toLowerCase() === segment.toLowerCase() &&
        f.referenceTo.length > 0,
    );
    if (!rel) return null;
    // Polymorphic refs: take the first (most common in user queries).
    current = rel.referenceTo[0];
  }
  return current;
}

/**
 * Resolve a relationship chain and return the target object's field list.
 * Awaits loads for any missing intermediate or terminal objects along the way,
 * so the FIRST time the user types `Foo.` we wait one round-trip; subsequent
 * traversals are instant from cache.
 *
 * Returns an empty list if any segment isn't a known relationship.
 */
export async function loadFieldsForRelationship(
  org: string,
  rootObject: string,
  path: string[],
): Promise<FieldInfo[]> {
  if (path.length === 0) return [];
  let current = rootObject;
  for (const segment of path) {
    const fields = await loadFields(org, current);
    const rel = fields.find(
      (f) =>
        f.relationshipName &&
        f.relationshipName.toLowerCase() === segment.toLowerCase() &&
        f.referenceTo.length > 0,
    );
    if (!rel) return [];
    current = rel.referenceTo[0];
  }
  return loadFields(org, current);
}

// ─────────────────────────────────────────────────────────────────────────────
// SObject catalog (per org)
// ─────────────────────────────────────────────────────────────────────────────

/** Forget a previous listObjects failure so the next loadObjectsFor retries
 *  immediately instead of silently no-oping inside the 30s backoff window.
 *  Used by the ObjectPicker's Retry button. */
export function clearObjectsFailure(org: string): void {
  objectsFailed.delete(org);
}

export async function loadObjectsFor(org: string): Promise<ObjectInfo[]> {
  const cached = objectsCache.get(org);
  if (cached) {
    if (state.currentOrg === org) state.currentObjects = cached;
    return cached;
  }
  const pending = objectsInflight.get(org);
  if (pending) return pending;

  const lastFail = objectsFailed.get(org);
  if (lastFail && Date.now() - lastFail < FAILURE_BACKOFF_MS) {
    return [];
  }

  const p = listObjects(org)
    .then((objs) => {
      objectsCache.set(org, objs);
      if (state.currentOrg === org) state.currentObjects = objs;
      return objs;
    })
    .catch((e) => {
      objectsFailed.set(org, Date.now());
      // eslint-disable-next-line no-console
      console.warn(
        `[schemaCache] listObjects for ${org} failed:`,
        toAppError(e).message,
      );
      return [] as ObjectInfo[];
    })
    .finally(() => {
      objectsInflight.delete(org);
    });

  objectsInflight.set(org, p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// FROM-object parsing + context notification
// ─────────────────────────────────────────────────────────────────────────────

export function extractFromObject(soql: string): string | null {
  // Strip string literals BEFORE counting paren depth — `WHERE Name = '(x'`
  // would otherwise skew the depth and make a subquery's FROM win. (Matches
  // the stripping detectSubqueryAtCursor does in soqlContext.ts.)
  const cleaned = soql
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(--|\/\/).*$/gm, " ");

  const re = /\bFROM\s+([A-Za-z][\w]*(?:__[cr])?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const before = cleaned.slice(0, m.index);
    let depth = 0;
    for (const ch of before) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth === 0) return m[1];
  }
  return null;
}

export function notifyEditorContext(
  org: string | null,
  object: string | null,
): void {
  state.currentOrg = org;
  state.currentObject = object;

  if (org) {
    const objs = objectsCache.get(org);
    state.currentObjects = objs ?? [];
  } else {
    state.currentObjects = [];
  }

  if (!org || !object) {
    state.currentFields = [];
    return;
  }
  const cached = fieldCache.get(fieldKey(org, object));
  state.currentFields = cached ?? [];
}

// Dev convenience: expose cache state on `window.__schemaCache` for inspection.
if (typeof window !== "undefined") {
  (
    window as unknown as { __schemaCache: unknown }
  ).__schemaCache = {
    state,
    fieldCache,
    childRelCache,
    fieldInflight,
    objectsCache,
    objectsInflight,
  };
}
