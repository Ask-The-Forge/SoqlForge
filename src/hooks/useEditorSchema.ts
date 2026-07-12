/**
 * useEditorSchema — keeps the schema cache in sync with the editor.
 *
 * Two effects:
 *   1. When the org changes, load that org's SObject list (for FROM-clause
 *      autocomplete) — eager, no debounce, runs once per org.
 *   2. When the editor text changes, parse the FROM-object and (debounced)
 *      load that object's fields — supports the SELECT/WHERE/etc. autocomplete.
 */

import { useEffect } from "react";
import {
  extractFromObject,
  loadFieldsFor,
  loadObjectsFor,
  notifyEditorContext,
} from "../lib/schemaCache";

const DEBOUNCE_MS = 300;

export function useEditorSchema(text: string, org: string | null): void {
  // Org-level: load the SObject list so FROM autocomplete has something to
  // suggest even before the user has typed any FROM clause.
  useEffect(() => {
    if (!org) {
      notifyEditorContext(null, null);
      return;
    }
    void loadObjectsFor(org);
  }, [org]);

  // Text-level: parse FROM and load fields for that object (debounced).
  useEffect(() => {
    if (!org) {
      notifyEditorContext(null, null);
      return;
    }
    const obj = extractFromObject(text);
    notifyEditorContext(org, obj);
    if (!obj) return;

    const handle = window.setTimeout(() => {
      void loadFieldsFor(org, obj);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [text, org]);
}
