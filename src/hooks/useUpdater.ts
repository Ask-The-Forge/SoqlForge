/**
 * Auto-update check via Tauri's updater plugin.
 *
 * Runs one silent check on startup. If a newer signed release is published to
 * GitHub Releases (see `.github/workflows/release.yml`), the returned state
 * exposes it so the UI can offer an install. The download + install is only
 * triggered on explicit user action — we never update behind their back.
 *
 * In `tauri dev` (or any non-bundled run) the updater is unconfigured; the
 * check throws and we swallow it, leaving state at "idle".
 */

import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterPhase =
  | "idle" // no update, or check failed silently (e.g. dev build)
  | "available" // a newer version is ready to install
  | "downloading" // install in progress
  | "installed"; // downloaded + installed, pending relaunch

export interface UpdaterState {
  phase: UpdaterPhase;
  /** The new version string once one is found (e.g. "0.2.0"). */
  version: string | null;
  /** Release notes from latest.json, if the publisher included any. */
  notes: string | null;
  /** Non-fatal error surfaced from a download/install attempt. */
  error: string | null;
  /** Download + install the pending update, then relaunch into it. */
  install: () => Promise<void>;
}

export function useUpdater(): UpdaterState {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Update | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        setPending(update);
        setVersion(update.version);
        setNotes(update.body ?? null);
        setPhase("available");
      } catch {
        // No updater configured (dev build) or the endpoint was unreachable.
        // A failed update check must never disrupt normal app use.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(async () => {
    if (!pending) return;
    setError(null);
    setPhase("downloading");
    try {
      await pending.downloadAndInstall();
      setPhase("installed");
      // Relaunch into the freshly installed version. On Windows the NSIS
      // installer may have already exited us; guard so a relaunch error
      // doesn't surface as an unhandled rejection.
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("available");
    }
  }, [pending]);

  return { phase, version, notes, error, install };
}
