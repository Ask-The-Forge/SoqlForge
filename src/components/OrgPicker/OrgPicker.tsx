/**
 * OrgPicker — dropdown listing authenticated Salesforce orgs.
 *
 * Status dot:  Connected → green, RefreshTokenError → red, Unknown/other → yellow
 *
 * Changing the active org clears the result grid (handled by the parent hook
 * via the appStore selector — useQuery listens to activeOrg and resets state).
 */

import { useEffect } from "react";
import { useOrgs } from "../../hooks/useOrgs";
import { useAppStore } from "../../stores/appStore";
import type { OrgEntry } from "../../lib/tauriClient";
import { StatusDot } from "../shared/StatusDot";
import { Spinner } from "../shared/Spinner";

function CliNotFoundBanner() {
  return (
    <div className="text-xs leading-relaxed rounded border border-amber-700/50 bg-amber-900/30 text-amber-200 p-3">
      <div className="font-medium mb-1">Salesforce CLI not found</div>
      <div className="opacity-90">
        Install it, then click <em>Refresh</em>:
      </div>
      <a
        className="text-amber-300 underline hover:text-amber-100"
        href="https://developer.salesforce.com/tools/salesforcecli"
        target="_blank"
        rel="noreferrer"
      >
        developer.salesforce.com/tools/salesforcecli
      </a>
    </div>
  );
}

export function OrgPicker() {
  const { orgs, loading, error, refresh } = useOrgs();
  const activeOrg = useAppStore((s) => s.activeOrg);
  const setActiveOrg = useAppStore((s) => s.setActiveOrg);
  const setOrgInstanceUrls = useAppStore((s) => s.setOrgInstanceUrls);

  // Publish alias/username → instance URL into the store so the results grid
  // can link each row out to Salesforce without another CLI round-trip.
  useEffect(() => {
    if (orgs.length === 0) return;
    const map: Record<string, string> = {};
    for (const o of orgs) {
      if (!o.instanceUrl) continue;
      if (o.alias) map[o.alias] = o.instanceUrl;
      if (o.username) map[o.username] = o.instanceUrl;
    }
    setOrgInstanceUrls(map);
  }, [orgs, setOrgInstanceUrls]);

  // Auto-pick ONLY the org the user marked as default in sf itself
  // (`sf config set target-org`). Never fall back to "first in the list" —
  // for people with client production orgs authenticated, silently selecting
  // an org they didn't choose is how a query (or an inline edit) ends up
  // pointed at the wrong place. No default → stay on "— select an org —".
  // If the persisted `activeOrg` no longer exists (org was logged out from
  // the CLI), clear it so the dropdown doesn't show a phantom entry.
  useEffect(() => {
    if (orgs.length === 0) return;
    const hasActive = activeOrg && orgs.some((o) => o.alias === activeOrg);
    if (hasActive) return;
    const pick: OrgEntry | undefined = orgs.find((o) => o.isDefault);
    setActiveOrg(pick ? pick.alias : null);
  }, [orgs, activeOrg, setActiveOrg]);

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-zinc-800">
      <div className="flex items-center gap-2">
        <label className="text-xs uppercase tracking-wide text-zinc-400">
          Org
        </label>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          title="Refresh org list"
        >
          {loading && <Spinner />}
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error?.code === "CLI_NOT_FOUND" ? (
        <CliNotFoundBanner />
      ) : error ? (
        <div className="text-xs text-red-400 break-words">{error.message}</div>
      ) : null}

      <div className="flex items-center gap-2 min-w-0">
        {/* min-w-0 + a tooltip with the full username keeps the closed
            select from blowing out the sidebar (default flex children won't
            shrink below their content width — long options would overflow
            into the editor pane). Option text is alias-only; the tooltip
            shows the full username + default-star context. */}
        <select
          value={activeOrg ?? ""}
          onChange={(e) => setActiveOrg(e.target.value || null)}
          disabled={orgs.length === 0}
          title={
            (orgs.find((o) => o.alias === activeOrg)?.username ?? "") +
            (orgs.find((o) => o.alias === activeOrg)?.isDefault
              ? " (sf default)"
              : "")
          }
          className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-blue-500 truncate"
        >
          {orgs.length === 0 ? (
            // `sf org list` is a slow CLI round-trip on a cold start —
            // "No authenticated orgs" while it's still running reads as a
            // failure the user has to act on.
            <option value="">
              {loading ? "Loading orgs…" : "No authenticated orgs"}
            </option>
          ) : (
            <>
              {!activeOrg && <option value="">— select an org —</option>}
              {orgs.map((o) => (
                <option key={o.username} value={o.alias}>
                  {o.alias}
                  {o.isDefault ? " (default)" : ""}
                </option>
              ))}
            </>
          )}
        </select>
        {activeOrg && (
          <StatusDot
            status={
              orgs.find((o) => o.alias === activeOrg)?.connectedStatus ??
              "Unknown"
            }
          />
        )}
      </div>
    </div>
  );
}
