/**
 * OrgManagerPanel — modal for org CRUD (login/logout/default/alias/open),
 * scratch-org expiration tracking, and DevHub package/version listing.
 *
 * Three tabs, all sourced from the same `useOrgs()` list (refreshed via the
 * shared `orgsVersion` counter after any mutation — see useOrgManage).
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { useOrgs } from "../../hooks/useOrgs";
import { useOrgManage } from "../../hooks/useOrgManage";
import { StatusDot } from "../shared/StatusDot";
import {
  type OrgEntry,
  type PackageInfo,
  type PackageVersionInfo,
  listPackages,
  listPackageVersions,
  toAppError,
} from "../../lib/tauriClient";

interface OrgManagerPanelProps {
  open: boolean;
  onClose: () => void;
}

type TabId = "orgs" | "scratch" | "packages";

const TABS: { id: TabId; label: string }[] = [
  { id: "orgs", label: "Orgs" },
  { id: "scratch", label: "Scratch Orgs" },
  { id: "packages", label: "Packages" },
];

function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00`).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

function expiryColor(days: number): string {
  if (days <= 2) return "text-red-400";
  if (days <= 7) return "text-amber-400";
  return "text-zinc-300";
}

export function OrgManagerPanel({ open, onClose }: OrgManagerPanelProps) {
  const [tab, setTab] = useState<TabId>("orgs");
  const { orgs, loading, error: orgsError, refresh } = useOrgs();
  const manage = useOrgManage();

  const [loginAlias, setLoginAlias] = useState("");
  const [renamingUsername, setRenamingUsername] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  if (!open) return null;

  const scratchOrgs = orgs
    .filter((o) => o.orgType === "Scratch")
    .sort((a, b) => {
      const ad = a.expirationDate ? daysUntil(a.expirationDate) : Infinity;
      const bd = b.expirationDate ? daysUntil(b.expirationDate) : Infinity;
      return ad - bd;
    });
  const devHubs = orgs.filter((o) => o.orgType === "DevHub");

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[820px] max-w-[95vw] h-[600px] max-h-[85vh] bg-zinc-950 border border-zinc-800 rounded flex flex-col"
      >
        <div className="flex items-center px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold">Org Manager</h2>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="ml-auto mr-3 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex border-b border-zinc-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-xs uppercase tracking-wide ${
                tab === t.id
                  ? "text-zinc-100 border-b-2 border-blue-500"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
              {t.id === "scratch" && scratchOrgs.length > 0 ? ` (${scratchOrgs.length})` : ""}
            </button>
          ))}
        </div>

        {(orgsError || manage.error) && (
          <div className="px-4 py-2 text-xs text-red-400 border-b border-zinc-800 break-words">
            {orgsError?.message ?? manage.error?.message}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto p-4">
          {tab === "orgs" && (
            <OrgsTab
              orgs={orgs}
              manage={manage}
              loginAlias={loginAlias}
              setLoginAlias={setLoginAlias}
              renamingUsername={renamingUsername}
              setRenamingUsername={setRenamingUsername}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
            />
          )}
          {tab === "scratch" && <ScratchTab scratchOrgs={scratchOrgs} manage={manage} />}
          {tab === "packages" && <PackagesTab devHubs={devHubs} />}
        </div>
      </div>
    </div>
  );
}

type ManageApi = ReturnType<typeof useOrgManage>;

function OrgsTab({
  orgs,
  manage,
  loginAlias,
  setLoginAlias,
  renamingUsername,
  setRenamingUsername,
  renameValue,
  setRenameValue,
}: {
  orgs: OrgEntry[];
  manage: ManageApi;
  loginAlias: string;
  setLoginAlias: (s: string) => void;
  renamingUsername: string | null;
  setRenamingUsername: (s: string | null) => void;
  renameValue: string;
  setRenameValue: (s: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          value={loginAlias}
          onChange={(e) => setLoginAlias(e.target.value)}
          placeholder="Alias (optional)"
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={() => void manage.loginWeb(loginAlias || undefined)}
          disabled={manage.pendingAction === "login"}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs disabled:opacity-50"
        >
          {manage.pendingAction === "login" ? "Waiting for browser…" : "Connect Org…"}
        </button>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-500 border-b border-zinc-800">
            <th className="py-1.5 pr-2 font-medium">Alias</th>
            <th className="py-1.5 pr-2 font-medium">Username</th>
            <th className="py-1.5 pr-2 font-medium">Type</th>
            <th className="py-1.5 pr-2 font-medium"></th>
            <th className="py-1.5 pr-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {orgs.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-4 text-center text-zinc-500">
                No authenticated orgs.
              </td>
            </tr>
          ) : (
            orgs.map((o) => {
              const busy = manage.pendingAction === o.username;
              const isRenaming = renamingUsername === o.username;
              return (
                <tr key={o.username} className="border-b border-zinc-900">
                  <td className="py-1.5 pr-2">
                    {isRenaming ? (
                      <div className="flex items-center gap-1">
                        <input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          autoFocus
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs w-24"
                        />
                        <button
                          onClick={async () => {
                            if (renameValue.trim()) {
                              await manage.setAlias(o.username, renameValue.trim());
                            }
                            setRenamingUsername(null);
                          }}
                          className="text-emerald-400 hover:text-emerald-300"
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => setRenamingUsername(null)}
                          className="text-zinc-500 hover:text-zinc-300"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <span>
                        {o.alias}
                        {o.isDefault ? " (default)" : ""}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-zinc-400 truncate max-w-[220px]" title={o.username}>
                    {o.username}
                  </td>
                  <td className="py-1.5 pr-2 text-zinc-400">{o.orgType}</td>
                  <td className="py-1.5 pr-2">
                    <StatusDot status={o.connectedStatus} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-2">
                      {!o.isDefault && (
                        <button
                          onClick={() => void manage.setDefault(o.username)}
                          disabled={busy}
                          className="text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                        >
                          Set default
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setRenamingUsername(o.username);
                          setRenameValue(o.alias);
                        }}
                        disabled={busy}
                        className="text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => void manage.open(o.username)}
                        disabled={busy}
                        className="text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => void manage.logout(o.username)}
                        disabled={busy}
                        className="text-red-400 hover:text-red-300 disabled:opacity-50"
                      >
                        {busy ? "…" : "Logout"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function ScratchTab({ scratchOrgs, manage }: { scratchOrgs: OrgEntry[]; manage: ManageApi }) {
  if (scratchOrgs.length === 0) {
    return <div className="text-xs text-zinc-500">No scratch orgs authenticated.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-zinc-500 border-b border-zinc-800">
          <th className="py-1.5 pr-2 font-medium">Alias</th>
          <th className="py-1.5 pr-2 font-medium">DevHub</th>
          <th className="py-1.5 pr-2 font-medium">Expires</th>
          <th className="py-1.5 pr-2 font-medium">Actions</th>
        </tr>
      </thead>
      <tbody>
        {scratchOrgs.map((o) => {
          const busy = manage.pendingAction === o.username;
          const days = o.expirationDate ? daysUntil(o.expirationDate) : null;
          return (
            <tr key={o.username} className="border-b border-zinc-900">
              <td className="py-1.5 pr-2">{o.alias}</td>
              <td className="py-1.5 pr-2 text-zinc-400">{o.devHubUsername ?? "—"}</td>
              <td className={`py-1.5 pr-2 ${days !== null ? expiryColor(days) : "text-zinc-500"}`}>
                {o.expirationDate ? `${o.expirationDate} (${days! >= 0 ? `${days}d left` : "expired"})` : "—"}
              </td>
              <td className="py-1.5 pr-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void manage.open(o.username)}
                    disabled={busy}
                    className="text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => void manage.deleteScratch(o.username)}
                    disabled={busy}
                    className="text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    {busy ? "…" : "Delete"}
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PackagesTab({ devHubs }: { devHubs: OrgEntry[] }) {
  const [devHubUsername, setDevHubUsername] = useState<string>("");
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [versionsByPackage, setVersionsByPackage] = useState<Record<string, PackageVersionInfo[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultDevHub = useMemo(
    () => devHubs.find((h) => h.isDefault)?.username ?? devHubs[0]?.username ?? "",
    [devHubs],
  );

  useEffect(() => {
    if (!devHubUsername && defaultDevHub) setDevHubUsername(defaultDevHub);
  }, [defaultDevHub, devHubUsername]);

  useEffect(() => {
    if (!devHubUsername) {
      setPackages([]);
      return;
    }
    setLoading(true);
    setError(null);
    listPackages(devHubUsername)
      .then(setPackages)
      .catch((e) => setError(toAppError(e).message))
      .finally(() => setLoading(false));
  }, [devHubUsername]);

  const toggleExpand = async (pkg: PackageInfo) => {
    if (expanded === pkg.id) {
      setExpanded(null);
      return;
    }
    setExpanded(pkg.id);
    if (!versionsByPackage[pkg.id]) {
      try {
        const versions = await listPackageVersions(devHubUsername, pkg.id);
        setVersionsByPackage((prev) => ({ ...prev, [pkg.id]: versions }));
      } catch (e) {
        setError(toAppError(e).message);
      }
    }
  };

  if (devHubs.length === 0) {
    return (
      <div className="text-xs text-zinc-500">
        No DevHub orgs authenticated. Connect one from the Orgs tab (must be enabled as a Dev Hub) to see packages.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400">Dev Hub</label>
        <select
          value={devHubUsername}
          onChange={(e) => setDevHubUsername(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
        >
          {devHubs.map((h) => (
            <option key={h.username} value={h.username}>
              {h.alias}
            </option>
          ))}
        </select>
        {loading && <span className="text-xs text-zinc-500">Loading…</span>}
      </div>

      {error && <div className="text-xs text-red-400 break-words">{error}</div>}

      {packages.length === 0 && !loading ? (
        <div className="text-xs text-zinc-500">No packages found for this Dev Hub.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="py-1.5 pr-2 font-medium">Name</th>
              <th className="py-1.5 pr-2 font-medium">Type</th>
              <th className="py-1.5 pr-2 font-medium">Namespace</th>
              <th className="py-1.5 pr-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <Fragment key={p.id}>
                <tr className="border-b border-zinc-900">
                  <td className="py-1.5 pr-2">{p.name}</td>
                  <td className="py-1.5 pr-2 text-zinc-400">{p.packageType}</td>
                  <td className="py-1.5 pr-2 text-zinc-400">{p.namespacePrefix ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    <button
                      onClick={() => void toggleExpand(p)}
                      className="text-zinc-400 hover:text-zinc-100"
                    >
                      {expanded === p.id ? "Hide versions" : "Show versions"}
                    </button>
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr className="border-b border-zinc-900 bg-zinc-900/40">
                    <td colSpan={4} className="py-2 px-2">
                      {!versionsByPackage[p.id] ? (
                        <span className="text-zinc-500">Loading versions…</span>
                      ) : versionsByPackage[p.id].length === 0 ? (
                        <span className="text-zinc-500">No versions found.</span>
                      ) : (
                        <table className="w-full">
                          <thead>
                            <tr className="text-left text-zinc-500">
                              <th className="py-1 pr-2 font-medium">Version</th>
                              <th className="py-1 pr-2 font-medium">Released</th>
                              <th className="py-1 pr-2 font-medium">Created</th>
                              <th className="py-1 pr-2 font-medium">Subscriber Package Version Id</th>
                            </tr>
                          </thead>
                          <tbody>
                            {versionsByPackage[p.id].map((v) => (
                              <tr key={v.id}>
                                <td className="py-1 pr-2">{v.version}</td>
                                <td className="py-1 pr-2">{v.isReleased ? "Yes" : "No"}</td>
                                <td className="py-1 pr-2 text-zinc-400">{v.createdDate ?? "—"}</td>
                                <td className="py-1 pr-2 text-zinc-400">
                                  {v.subscriberPackageVersionId ?? "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
