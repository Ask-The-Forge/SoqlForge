/**
 * useOrgManage — mutating org-management actions (login/logout/set-default/
 * rename/open/delete-scratch). Each action bumps the shared `orgsVersion`
 * counter on success so every `useOrgs` consumer re-fetches.
 *
 * `pendingAction` is a caller-supplied string id (e.g. a username or
 * "login") so the UI can show a spinner on the specific row/button that
 * triggered the action, rather than a single global loading flag.
 */

import { useCallback, useState } from "react";
import {
  type AppError,
  type OrgEntry,
  orgDeleteScratch,
  orgLoginWeb,
  orgLogout,
  orgOpen,
  orgSetAlias,
  orgSetDefault,
  toAppError,
} from "../lib/tauriClient";
import { useAppStore } from "../stores/appStore";

interface UseOrgManageResult {
  pendingAction: string | null;
  error: AppError | null;
  clearError: () => void;
  loginWeb: (alias?: string, instanceUrl?: string) => Promise<OrgEntry | null>;
  logout: (username: string) => Promise<boolean>;
  setDefault: (username: string) => Promise<boolean>;
  setAlias: (username: string, alias: string) => Promise<boolean>;
  open: (username: string) => Promise<boolean>;
  deleteScratch: (username: string) => Promise<boolean>;
}

export function useOrgManage(): UseOrgManageResult {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const bumpOrgsVersion = useAppStore((s) => s.bumpOrgsVersion);

  const run = useCallback(
    async <T,>(actionId: string, fn: () => Promise<T>): Promise<T | null> => {
      setPendingAction(actionId);
      setError(null);
      try {
        const result = await fn();
        bumpOrgsVersion();
        return result;
      } catch (e) {
        setError(toAppError(e));
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [bumpOrgsVersion],
  );

  const loginWeb = useCallback(
    (alias?: string, instanceUrl?: string) =>
      run("login", () => orgLoginWeb(alias, instanceUrl)),
    [run],
  );
  const logout = useCallback(
    (username: string) => run(username, () => orgLogout(username)).then((r) => r !== null),
    [run],
  );
  const setDefault = useCallback(
    (username: string) => run(username, () => orgSetDefault(username)).then((r) => r !== null),
    [run],
  );
  const setAlias = useCallback(
    (username: string, alias: string) =>
      run(username, () => orgSetAlias(username, alias)).then((r) => r !== null),
    [run],
  );
  const open = useCallback(
    (username: string) => run(username, () => orgOpen(username)).then((r) => r !== null),
    [run],
  );
  const deleteScratch = useCallback(
    (username: string) =>
      run(username, () => orgDeleteScratch(username)).then((r) => r !== null),
    [run],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    pendingAction,
    error,
    clearError,
    loginWeb,
    logout,
    setDefault,
    setAlias,
    open,
    deleteScratch,
  };
}
