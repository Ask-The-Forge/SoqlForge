/**
 * useOrgs — list authenticated orgs from the Salesforce CLI.
 *
 * Manual refresh only (no polling in v1). Surfaces a structured error so the
 * UI can render "sf not found" with an install link, vs a transient failure.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type AppError,
  type OrgEntry,
  listOrgs,
  toAppError,
} from "../lib/tauriClient";
import { useAppStore } from "../stores/appStore";

interface UseOrgsResult {
  orgs: OrgEntry[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
}

export function useOrgs(): UseOrgsResult {
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Bumped by useOrgManage after login/logout/set-default/rename/delete —
  // re-fetching here keeps every useOrgs consumer (sidebar picker, Org
  // Manager panel) in sync without them knowing about each other.
  const orgsVersion = useAppStore((s) => s.orgsVersion);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listOrgs();
      // Connected orgs first, then alphabetical by alias.
      list.sort((a, b) => {
        const ac = a.connectedStatus === "Connected" ? 0 : 1;
        const bc = b.connectedStatus === "Connected" ? 0 : 1;
        if (ac !== bc) return ac - bc;
        return a.alias.localeCompare(b.alias);
      });
      setOrgs(list);
    } catch (e) {
      setError(toAppError(e));
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, orgsVersion]);

  return { orgs, loading, error, refresh };
}
