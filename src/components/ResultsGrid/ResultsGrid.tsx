/**
 * ResultsGrid — virtualized table for SOQL results.
 *
 * - TanStack Table v8 for column/sort state, TanStack Virtual for row windowing
 * - Columns discovered from records (incl. dot-notation for relationships)
 * - Client-side sort (results often fit in memory; sf handles pagination upstream)
 * - Column resize via header drag
 * - CSV export + "Copy Table" (TSV to the clipboard) buttons. Both emit the
 *   table as displayed — current sort and column order included
 * - Leading action column: an eye button per row opens the record in
 *   Salesforce (default browser) via the org's instance URL; a trash button
 *   deletes it after an explicit confirmation dialog
 * - Column headers show the field's type (from the describe cache), with a
 *   ⨍ marker for formula fields; double-clicking a read-only cell surfaces
 *   WHY it can't be edited in a transient toolbar notice
 * - "Object Setup" toolbar button opens the FROM-object's Fields &
 *   Relationships page in Salesforce Setup
 * - Long text / object cells get an expand button → full-value detail modal,
 *   since every cell is clipped to one line
 * - Cell renderers: null=empty, bool=☑/☐, 18-char ID=copy icon on hover
 *
 * Important: the heavy `useVirtualizer` + `useReactTable` hooks live in a
 * dedicated child component that ONLY mounts when there's an actual result.
 * Previously they ran on every App re-render (even with 0 rows) and caused
 * WebView2 to deadlock when a re-render happened inside a mouse-event handler.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnDef,
  type ColumnOrderState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import {
  deleteRecord,
  type FieldInfo,
  type QueryResult,
  saveCsv,
  toAppError,
  updateRecord,
} from "../../lib/tauriClient";
import { useAppStore, type ResultContext } from "../../stores/appStore";
import {
  getCachedFields,
  loadFields,
  resolveRelationshipPath,
} from "../../lib/schemaCache";
import { buildCsv, buildTsv, csvCell, flattenValue, pickDisplayValue } from "./csv";
import { discoverColumns } from "./columnDiscovery";
import { parseSelectFields } from "./selectFields";
import { CellEditor, type CommitValue } from "./CellEditor";
import { Spinner } from "../shared/Spinner";

interface ResultsGridProps {
  result: QueryResult | null;
  /** The query text that produced this result.
   *  Used both to render the 0-rows-state hint and to establish canonical
   *  column ordering (matches the order the user typed in the SELECT clause). */
  lastRanQuery?: string | null;
  /** Provenance of the result (org + FROM-object captured at run time).
   *  The inline-edit path is keyed off this — NEVER off the live editor
   *  text, which the user may have changed since the run. */
  resultContext?: ResultContext | null;
}

type Row = Record<string, unknown>;

const ID_REGEX = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** Width (px) of the leading action column that holds the "open record in
 *  Salesforce" eye button — and, when the result is deletable, the trash
 *  button next to it. */
const ACTION_COL_WIDTH = 34;
const ACTION_COL_WIDTH_WITH_DELETE = 58;

/** Strings longer than this get an expand affordance + detail modal, since the
 *  grid clips every cell to a single line and long text areas are unreadable
 *  inline. */
const LONG_TEXT_THRESHOLD = 60;

/** The full text worth surfacing in the detail modal, or null when the value
 *  is short/simple enough to read inline. Objects (subquery/relationship
 *  summaries) are always expandable — their one-line summary hides the rest. */
function expandableText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > LONG_TEXT_THRESHOLD ? value : null;
  }
  if (value && typeof value === "object") return csvCell(value);
  return null;
}

/** Human-friendly one-liner for a column header's field type. Formula fields
 *  get a ⨍ prefix, lookups show their target object(s). */
function fieldTypeLabel(f: FieldInfo): string {
  let base = f.fieldType;
  if (f.fieldType === "reference" && f.referenceTo.length) {
    const targets = f.referenceTo.slice(0, 2).join(", ");
    base = `lookup(${targets}${f.referenceTo.length > 2 ? ", …" : ""})`;
  }
  return f.calculated ? `⨍ ${base}` : base;
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") {
    return (
      <span className="text-zinc-300" aria-label={value ? "true" : "false"}>
        {value ? "☑" : "☐"}
      </span>
    );
  }
  if (typeof value === "object") {
    // Subquery results / unflattened relationship objects — render the same
    // human summary that CSV export uses so what you see is what you get.
    const summary = csvCell(value);
    return (
      <span className="text-zinc-400 italic" title={summary}>
        {summary}
      </span>
    );
  }
  const s = String(value);
  if (typeof value === "string" && ID_REGEX.test(s)) {
    return (
      <span className="group inline-flex items-center gap-1">
        <span className="font-mono text-zinc-200">{s}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(s);
          }}
          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-zinc-100 transition-opacity"
          title="Copy ID"
        >
          ⧉
        </button>
      </span>
    );
  }
  return <span>{s}</span>;
}

/**
 * Outer component — handles the three empty-states (no result, 0 records, has
 * records). The expensive virtualization hooks live in `RowsGrid` below and
 * are only instantiated when records are non-empty.
 */
export function ResultsGrid({
  result,
  lastRanQuery,
  resultContext,
}: ResultsGridProps) {
  // Key the heavy grid by tab so per-grid UI state (sorting, in-progress
  // edit, cell error) never leaks across tab switches.
  const activeTabId = useAppStore((s) => s.activeTabId);
  if (!result) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        Run a query to see results.
      </div>
    );
  }

  const records = result.records as Row[];

  if (records.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-500 text-sm p-6">
        <div>Query returned 0 records.</div>
        {lastRanQuery && (
          <pre className="max-w-full text-xs font-mono text-zinc-600 bg-zinc-900/40 border border-zinc-800 rounded p-3 whitespace-pre-wrap break-words">
            {lastRanQuery}
          </pre>
        )}
      </div>
    );
  }

  return (
    <RowsGrid
      key={activeTabId}
      result={result}
      records={records}
      lastRanQuery={lastRanQuery ?? null}
      resultContext={resultContext ?? null}
    />
  );
}

/**
 * The heavy grid — TanStack Table + Virtual, only mounted when there's data.
 */
function RowsGrid({
  result,
  records,
  lastRanQuery,
  resultContext,
}: {
  result: QueryResult;
  records: Row[];
  lastRanQuery: string | null;
  resultContext: ResultContext | null;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);

  // Column path discovery — three sources, merged in priority order:
  //   1. The user's SELECT clause (canonical order) — what they typed should
  //      be what they see
  //   2. Backend-provided columns (from the first record's keys) — picks up
  //      anything the parser missed
  //   3. Deep-walk of all records — catches nested relationship paths the
  //      first record didn't reveal (null relationships in record 0)
  const { columnPaths, columnLabels } = useMemo(() => {
    const fromSelect = lastRanQuery
      ? parseSelectFields(lastRanQuery)
      : [];
    const backend = result.columns ?? [];
    const discovered = discoverColumns(records);

    const out: string[] = [];
    const seen = new Set<string>();
    const labels = new Map<string, string>();
    const push = (col: string, label?: string) => {
      if (!col || col.startsWith("attributes")) return;
      if (seen.has(col)) return;
      seen.add(col);
      out.push(col);
      if (label && label !== col) labels.set(col, label);
    };

    // Case-insensitive match against the backend/discovery sets so the SELECT
    // order wins even when casing differs (SOQL is case-insensitive).
    const allKnown = new Map<string, string>();
    for (const c of [...backend, ...discovered]) {
      if (!allKnown.has(c.toLowerCase())) allKnown.set(c.toLowerCase(), c);
    }

    for (const f of fromSelect) {
      // Prefer the canonical casing from the data, fall back to what the user typed
      const canonical = allKnown.get(f.key.toLowerCase()) ?? f.key;
      push(canonical, f.label);
    }
    for (const col of backend) push(col);
    for (const col of discovered) push(col);

    // Suppress a bare parent column when its children are already flattened
    // into dot columns: `SELECT Account.Name FROM Contact` yields both an
    // "Account.Name" column (from the SELECT/discovery) and a raw "Account"
    // key from the backend that would render as ugly JSON. Keep just the
    // flattened ones. (Subquery columns like "Contacts" are unaffected — no
    // dot column is ever derived from a subquery envelope.)
    const filtered = out.filter(
      (c) => !out.some((o) => o !== c && o.startsWith(c + ".")),
    );
    return { columnPaths: filtered, columnLabels: labels };
  }, [records, result.columns, lastRanQuery]);

  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      columnPaths.map((path) => ({
        id: path,
        header: columnLabels.get(path) ?? path,
        accessorFn: (row) => flattenValue(row, path),
        cell: (info) => <CellValue value={info.getValue()} />,
        size: 180,
        sortingFn: (a, b, colId) => {
          const av = flattenValue(a.original, colId) as unknown;
          const bv = flattenValue(b.original, colId) as unknown;
          if (av === bv) return 0;
          if (av === null || av === undefined) return -1;
          if (bv === null || bv === undefined) return 1;
          if (typeof av === "number" && typeof bv === "number") return av - bv;
          return String(av).localeCompare(String(bv), undefined, {
            numeric: true,
            sensitivity: "base",
          });
        },
      })),
    [columnPaths, columnLabels],
  );

  // User-controlled column ordering. Initialized from `columnPaths` (which
  // already respects SELECT order) and updated when the user drags headers.
  // We reset back to the parsed order whenever the underlying query changes.
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(columnPaths);
  useEffect(() => {
    setColumnOrder(columnPaths);
  }, [columnPaths]);

  const table = useReactTable({
    data: records,
    columns,
    state: { sorting, columnOrder },
    onSortingChange: setSorting,
    onColumnOrderChange: setColumnOrder,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const rowModel = table.getRowModel();
  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const [exportSaved, setExportSaved] = useState<string | null>(null);
  // Transient "it worked" toolbar note for copy/delete. Deliberately NOT reset
  // by the new-result effect below — a delete replaces the result object, and
  // the confirmation of that delete has to outlive it.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  // ── Inline cell editing ────────────────────────────────────────────────
  // Drives the per-cell CellEditor swap. `rowIdx` is the index into the
  // sorted+filtered rowModel (we look up the underlying record via row.original
  // when committing). `colId` is the column path — only top-level paths
  // (no dots) can be edited.
  const [editing, setEditing] = useState<{
    rowIdx: number;
    colId: string;
  } | null>(null);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  // Transient toolbar notice explaining why a double-clicked cell won't edit
  // (formula field, wrong org, Tooling API result, …).
  const [editNotice, setEditNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!editNotice) return;
    const t = setTimeout(() => setEditNotice(null), 6000);
    return () => clearTimeout(t);
  }, [editNotice]);
  const [cellError, setCellError] = useState<{
    rowIdx: number;
    colId: string;
    msg: string;
  } | null>(null);

  // New result (re-run in the same tab): drop any in-progress edit and stale
  // cell-error highlight — their row/col coordinates belong to the old rows.
  useEffect(() => {
    setEditing(null);
    setCellError(null);
    setEditNotice(null);
  }, [result]);

  const activeOrg = useAppStore((s) => s.activeOrg);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const updateTabRecord = useAppStore((s) => s.updateTabRecord);
  const deleteTabRecord = useAppStore((s) => s.deleteTabRecord);
  const orgInstanceUrls = useAppStore((s) => s.orgInstanceUrls);

  // Instance URL of the org that produced these rows — lets each row link out
  // to the record in Salesforce. Keyed off the result's provenance (falling
  // back to the active org), so it stays correct even if the user switched the
  // picker after running. Null when the org list hasn't reported a URL yet.
  const instanceUrl = useMemo(() => {
    const org = resultContext?.org ?? activeOrg;
    const url = org ? orgInstanceUrls[org] : null;
    return url ? url.replace(/\/+$/, "") : null;
  }, [orgInstanceUrls, resultContext, activeOrg]);

  // Full-value detail modal for long text / object cells (the grid truncates
  // every cell to one line). `label` is the column path, `value` the full text.
  const [detail, setDetail] = useState<{ label: string; value: string } | null>(
    null,
  );
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  // Org + FROM-object that produced these rows — drives field metadata
  // (column-header types) and the Object Setup link. Tooling API results are
  // excluded: the standard describe doesn't cover those objects.
  const metaOrg =
    resultContext && !resultContext.useToolingApi ? resultContext.org : null;
  const metaObject = metaOrg ? resultContext?.objectName ?? null : null;

  // The edit path is keyed STRICTLY off the result's provenance (org +
  // FROM-object captured when the run completed) — never off the live editor
  // text, which the user may have rewritten since. Editing additionally
  // requires the active org to still match the result's org (sf data update
  // record hits whatever org is targeted).
  const editOrg = metaOrg && metaOrg === activeOrg ? metaOrg : null;
  const editObject = editOrg ? metaObject : null;

  // Field-info lookup for the result's FROM-object, from the describe cache.
  // `fieldsVersion` MUST be a dep — it's what invalidates the memo once the
  // async describe arrives (metaOrg/metaObject won't have changed by then).
  const [fieldsVersion, setFieldsVersion] = useState(0);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const fieldInfo = useMemo(() => {
    const map = new Map<string, FieldInfo>();
    if (!metaOrg || !metaObject) return map;
    const fields = getCachedFields(metaOrg, metaObject);
    if (!fields) return map;
    for (const f of fields) {
      map.set(f.name.toLowerCase(), f);
    }
    return map;
  }, [metaOrg, metaObject, fieldsVersion]);

  // Cold describe cache: fetch in the background and re-render when it lands,
  // so column types appear and cells become editable without re-running the
  // query. Surfaced in the toolbar because the wait is a visible CLI
  // round-trip — until it resolves the grid looks type-less for no reason.
  useEffect(() => {
    if (!metaOrg || !metaObject) return;
    if (getCachedFields(metaOrg, metaObject)) return;
    let cancelled = false;
    setFieldsLoading(true);
    void loadFields(metaOrg, metaObject)
      .then((loaded) => {
        if (!cancelled && loaded.length) setFieldsVersion((v) => v + 1);
      })
      .finally(() => {
        if (!cancelled) setFieldsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [metaOrg, metaObject]);

  // Per-column field metadata, including dot columns (Account.Name) resolved
  // through the describe cache. Dot paths resolve only from what's already
  // cached — we don't fan out extra describes just for header labels; the
  // editor's autocomplete usually pre-loaded them anyway.
  const columnFieldInfo = useMemo(() => {
    const map = new Map<string, FieldInfo>();
    if (!metaOrg || !metaObject) return map;
    for (const path of columnPaths) {
      const parts = path.split(".");
      if (parts.length === 1) {
        const f = fieldInfo.get(path.toLowerCase());
        if (f) map.set(path, f);
        continue;
      }
      const target = resolveRelationshipPath(
        metaOrg,
        metaObject,
        parts.slice(0, -1),
      );
      if (!target) continue;
      const leaf = parts[parts.length - 1].toLowerCase();
      const f = getCachedFields(metaOrg, target)?.find(
        (x) => x.name.toLowerCase() === leaf,
      );
      if (f) map.set(path, f);
    }
    return map;
  }, [columnPaths, fieldInfo, metaOrg, metaObject]);

  /** Can this (col, row) be inline-edited? */
  function isEditable(colId: string, row: Row): FieldInfo | null {
    if (!editOrg || !editObject) return null;
    if (colId.includes(".")) return null; // relationship path — not editable here
    if (colId === "Id") return null;
    const field = fieldInfo.get(colId.toLowerCase());
    if (!field || !field.updateable) return null;
    if (!row.Id || typeof row.Id !== "string") return null;
    return field;
  }

  /** Why can't this cell be edited? Surfaced when the user double-clicks a
   *  non-editable cell — silently doing nothing (the old behavior) read as
   *  a bug, especially on formula fields. Null = no explanation available. */
  function readOnlyReason(colId: string, row: Row): string | null {
    if (!resultContext) return null;
    if (resultContext.useToolingApi)
      return "Tooling API results are read-only.";
    if (resultContext.org !== activeOrg)
      return `This result came from org "${resultContext.org}" — switch back to that org to edit.`;
    if (!editObject) return null;
    if (colId.includes("."))
      return "Relationship fields can't be edited here — query the related object directly.";
    if (colId === "Id") return "Record Ids can't be edited.";
    const field = fieldInfo.get(colId.toLowerCase());
    if (!field) return null;
    if (field.calculated)
      return `${field.name} is a formula field — its value is calculated by Salesforce and can't be edited.`;
    if (!field.updateable)
      return `${field.name} is read-only (not updateable via the API).`;
    if (!row.Id || typeof row.Id !== "string")
      return "This row has no Id — include Id in your SELECT to enable editing.";
    return null;
  }

  async function commitEdit(rowIdx: number, colId: string, next: CommitValue) {
    setEditing(null);
    setCellError(null);
    const row = records[rowIdx];
    if (!row || !editOrg || !editObject) return;
    const recordId = row.Id as string;
    const cellKey = `${rowIdx}::${colId}`;
    const prev = row[colId];
    if (prev === next) return; // no-op
    // A row that never carried this key (possible for sparse Bulk-API
    // records) reads as undefined; committing null there would CLEAR a field
    // the user never saw — treat it as a no-op instead.
    if (prev === undefined && next === null) return;
    setSavingCell(cellKey);
    try {
      await updateRecord({
        orgAlias: editOrg,
        objectName: editObject,
        recordId,
        values: { [colId]: next },
      });
      // Reflect the change in the grid without re-querying.
      updateTabRecord(activeTabId, rowIdx, colId, next);
    } catch (e) {
      setCellError({ rowIdx, colId, msg: toAppError(e).message });
    } finally {
      setSavingCell(null);
    }
  }

  // ── Row delete ───────────────────────────────────────────────────────────
  // Same provenance rule as editing — the rows must have come from the org
  // that's active right now, since `sf data delete record` hits whatever org
  // is targeted. Unlike editing it needs no field metadata (there are no
  // per-field permissions involved) and it works on Tooling objects too, so
  // the FROM-object plus a row Id is enough.
  const deleteOrg =
    resultContext && resultContext.org === activeOrg ? resultContext.org : null;
  const deleteObject = deleteOrg ? resultContext?.objectName ?? null : null;
  const canDelete = !!(deleteOrg && deleteObject);

  const [confirmDelete, setConfirmDelete] = useState<{
    rowIdx: number;
    recordId: string;
    label: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Esc dismisses the confirmation — but never mid-delete, where it would
  // hide a call that's still going to land.
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) setConfirmDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, deleting]);

  async function doDelete() {
    if (!confirmDelete || !deleteOrg || !deleteObject) return;
    const { rowIdx, recordId } = confirmDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRecord({
        orgAlias: deleteOrg,
        objectName: deleteObject,
        recordId,
        useToolingApi: !!resultContext?.useToolingApi,
      });
      // Dropping the row shifts every index after it; anything keyed by row
      // index (in-progress edit, cell error) is cleared by the result-change
      // effect above, which fires because this writes a new result object.
      deleteTabRecord(activeTabId, rowIdx);
      setConfirmDelete(null);
      setFlash(`Deleted ${deleteObject} ${recordId}`);
    } catch (e) {
      setDeleteError(toAppError(e).message);
    } finally {
      setDeleting(false);
    }
  }

  /** The table exactly as displayed — current sort, current column order.
   *  Both the CSV export and the clipboard copy go through this so what you
   *  see is what you get. */
  function displayedTable() {
    return {
      cols: table.getVisibleLeafColumns().map((c) => c.id),
      rows: rowModel.rows.map((r) => r.original),
    };
  }

  const handleExport = async () => {
    setActionError(null);
    setExportSaved(null);
    const { cols, rows } = displayedTable();
    const csv = buildCsv(rows, cols, columnLabels);
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, "-")
      .replace(/\..+/, "");
    try {
      const res = await saveCsv(csv, `soqlforge-${stamp}.csv`);
      if (res.path) {
        // Stays visible (no auto-clear) so the "Open" button is reachable.
        setExportSaved(res.path);
      }
    } catch (e) {
      setActionError(`Export failed: ${toAppError(e).message}`);
    }
  };

  /** Copy the whole table to the clipboard as TSV — no save dialog, no file.
   *  Pastes straight into Excel/Sheets or a message. */
  const handleCopyTable = async () => {
    setActionError(null);
    setExportSaved(null);
    const { cols, rows } = displayedTable();
    try {
      await navigator.clipboard.writeText(buildTsv(rows, cols, columnLabels));
      setFlash(
        `Copied ${rows.length.toLocaleString()} row${
          rows.length === 1 ? "" : "s"
        } × ${cols.length} column${cols.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      setActionError(`Copy failed: ${toAppError(e).message}`);
    }
  };

  const totalWidth = table.getCenterTotalSize();
  const actionColWidth = canDelete
    ? ACTION_COL_WIDTH_WITH_DELETE
    : ACTION_COL_WIDTH;
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom =
    virtualizer.getTotalSize() -
    (virtualRows[virtualRows.length - 1]?.end ?? 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800 text-xs text-zinc-400">
        <span>
          {result.synthesizedCount
            ? "count result"
            : `${records.length.toLocaleString()} row${
                records.length === 1 ? "" : "s"
              }${
                result.totalSize > records.length
                  ? ` of ${result.totalSize.toLocaleString()}`
                  : ""
              }`}
        </span>
        <span className="text-zinc-600">·</span>
        <span>{columnPaths.length} columns</span>
        {fieldsLoading && (
          <span
            className="flex items-center gap-1.5 text-zinc-500"
            title="Fetching the object describe — field types and inline editing light up when it lands."
          >
            <Spinner label="Loading field types" />
            Loading field types…
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 min-w-0">
          {flash && (
            <span className="text-emerald-400 truncate max-w-[40ch]" title={flash}>
              {flash}
            </span>
          )}
          {editNotice && (
            <span
              className="text-amber-400 truncate max-w-[60ch]"
              title={editNotice}
            >
              {editNotice}
            </span>
          )}
          {exportSaved && (
            <>
              <span
                className="text-emerald-400 truncate max-w-[40ch]"
                title={exportSaved}
              >
                Saved → {exportSaved}
              </span>
              <button
                onClick={() => {
                  if (exportSaved) void openPath(exportSaved);
                }}
                className="text-emerald-300 hover:text-emerald-100 border border-emerald-800 hover:border-emerald-600 rounded px-2 py-0.5 whitespace-nowrap"
                title="Open the saved file in the OS default app"
              >
                Open
              </button>
            </>
          )}
          {actionError && (
            <span
              className="text-red-400 truncate max-w-[40ch]"
              title={actionError}
            >
              {actionError}
            </span>
          )}
          {metaObject && instanceUrl && (
            <button
              onClick={() =>
                void openUrl(
                  `${instanceUrl}/lightning/setup/ObjectManager/${metaObject}/FieldsAndRelationships/view`,
                )
              }
              className="text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-2 py-0.5 whitespace-nowrap"
              title={`Open ${metaObject} → Fields & Relationships in Salesforce Setup`}
            >
              Object Setup ↗
            </button>
          )}
          <button
            onClick={() => void handleCopyTable()}
            className="text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-2 py-0.5 whitespace-nowrap"
            title="Copy the whole table to the clipboard (tab-separated — pastes into Excel, Sheets or a message). No file, no dialog."
          >
            Copy Table
          </button>
          <button
            onClick={() => void handleExport()}
            className="text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-2 py-0.5 whitespace-nowrap"
            title="Export to CSV"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
        style={{ contain: "strict" }}
      >
        <table
          className="border-separate border-spacing-0 text-xs"
          style={{ width: totalWidth + actionColWidth, tableLayout: "fixed" }}
        >
          <thead className="sticky top-0 z-10 bg-zinc-900">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                <th
                  style={{ width: actionColWidth }}
                  className="px-1 py-1.5 border-b border-r border-zinc-700 bg-zinc-900"
                  aria-label="Row actions"
                />
                {hg.headers.map((header) => {
                  // Drag-and-drop column reordering. HTML5 DnD keeps the impl
                  // dependency-free; we move the dragged column into the drop
                  // target's slot in the columnOrder state on `drop`.
                  const colId = header.column.id;
                  const finfo = columnFieldInfo.get(colId) ?? null;
                  const typeText = finfo ? fieldTypeLabel(finfo) : null;
                  const readOnlySuffix = finfo
                    ? finfo.calculated
                      ? " · formula (read-only)"
                      : !finfo.updateable
                        ? " · read-only"
                        : ""
                    : "";
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() }}
                      className="relative text-left px-2 py-1.5 border-b border-r border-zinc-700 font-medium text-zinc-200 select-none"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", colId);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const src = e.dataTransfer.getData("text/plain");
                        if (!src || src === colId) return;
                        setColumnOrder((prev) => {
                          const order = prev.length
                            ? [...prev]
                            : columnPaths.slice();
                          const fromIdx = order.indexOf(src);
                          const toIdx = order.indexOf(colId);
                          if (fromIdx === -1 || toIdx === -1) return prev;
                          order.splice(fromIdx, 1);
                          order.splice(toIdx, 0, src);
                          return order;
                        });
                      }}
                      title={`${colId}${typeText ? ` — ${typeText}` : ""}${readOnlySuffix} (drag to reorder)`}
                    >
                      <div
                        onClick={header.column.getToggleSortingHandler()}
                        className="cursor-grab active:cursor-grabbing flex items-center gap-1 truncate"
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        <span className="text-zinc-500">
                          {header.column.getIsSorted() === "asc"
                            ? "▲"
                            : header.column.getIsSorted() === "desc"
                              ? "▼"
                              : ""}
                        </span>
                      </div>
                      {typeText && (
                        <div
                          className={
                            "text-[10px] font-normal leading-tight truncate " +
                            (finfo?.calculated
                              ? "text-amber-500/80"
                              : "text-zinc-500")
                          }
                        >
                          {typeText}
                        </div>
                      )}
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-500"
                      />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td colSpan={columns.length + 1} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((vr) => {
              const row = rowModel.rows[vr.index];
              // `rowIdx` indexes into the underlying `records` array (not the
              // sorted row model). TanStack's row.index is exactly that — the
              // index into `data` — and is O(1), unlike an indexOf scan that
              // costs O(rows) per visible row per render.
              const originalRowIdx = row.index;
              const recordId =
                typeof row.original.Id === "string"
                  ? (row.original.Id as string)
                  : null;
              return (
                <tr
                  key={row.id}
                  className="odd:bg-zinc-950 even:bg-zinc-900/40 hover:bg-zinc-800/50"
                  style={{ height: vr.size }}
                >
                  <td
                    style={{ width: actionColWidth }}
                    className="px-1 border-b border-r border-zinc-800 align-middle"
                  >
                    <div className="flex items-center justify-center gap-1.5">
                      {recordId && instanceUrl && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void openUrl(`${instanceUrl}/${recordId}`);
                          }}
                          className="text-zinc-600 hover:text-blue-400 transition-colors"
                          title="Open record in Salesforce"
                          aria-label="Open record in Salesforce"
                        >
                          <EyeIcon />
                        </button>
                      )}
                      {recordId && canDelete && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteError(null);
                            setConfirmDelete({
                              rowIdx: originalRowIdx,
                              recordId,
                              label: pickDisplayValue(row.original),
                            });
                          }}
                          className="text-zinc-600 hover:text-red-400 transition-colors"
                          title={`Delete this ${deleteObject} record`}
                          aria-label="Delete record"
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  </td>
                  {row.getVisibleCells().map((cell) => {
                    const colId = cell.column.id;
                    const cellKey = `${originalRowIdx}::${colId}`;
                    const isEditing =
                      editing?.rowIdx === originalRowIdx &&
                      editing?.colId === colId;
                    const isSaving = savingCell === cellKey;
                    const errHere =
                      cellError?.rowIdx === originalRowIdx &&
                      cellError?.colId === colId
                        ? cellError.msg
                        : null;
                    const field = isEditable(colId, row.original);
                    const rawValue = cell.getValue();
                    const expandable = isEditing
                      ? null
                      : expandableText(rawValue);
                    return (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className={
                          "group/cell overflow-hidden px-2 py-1 border-b border-r border-zinc-800 " +
                          (isSaving ? "opacity-60 " : "") +
                          (errHere ? "bg-red-950/40 " : "") +
                          (field ? "cursor-cell" : "")
                        }
                        title={
                          errHere ??
                          (field
                            ? "Double-click to edit"
                            : typeof rawValue === "string"
                              ? rawValue
                              : undefined)
                        }
                        onDoubleClick={(e) => {
                          if (!field) {
                            const reason = readOnlyReason(colId, row.original);
                            if (reason) setEditNotice(reason);
                            return;
                          }
                          e.preventDefault();
                          setCellError(null);
                          setEditing({ rowIdx: originalRowIdx, colId });
                        }}
                      >
                        {isEditing && field ? (
                          <CellEditor
                            field={field}
                            initialValue={row.original[colId]}
                            onCommit={(next) =>
                              void commitEdit(originalRowIdx, colId, next)
                            }
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          <div className="flex items-center gap-1 min-w-0">
                            <div className="truncate min-w-0">
                              {flexRender(
                                cell.column.columnDef.cell,
                                cell.getContext(),
                              )}
                            </div>
                            {expandable !== null && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDetail({ label: colId, value: expandable });
                                }}
                                className="shrink-0 text-zinc-500 hover:text-blue-400 opacity-0 group-hover/cell:opacity-100 transition-opacity"
                                title="View full value"
                                aria-label="View full value"
                              >
                                ⤢
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  style={{ height: paddingBottom }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
          onClick={() => setDetail(null)}
        >
          <div
            className="flex flex-col w-full max-w-3xl max-h-[80vh] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800">
              <span
                className="text-sm font-medium text-zinc-200 truncate"
                title={detail.label}
              >
                {detail.label}
              </span>
              <span className="text-xs text-zinc-500 shrink-0">
                {detail.value.length.toLocaleString()} chars
              </span>
              <button
                onClick={() => void navigator.clipboard.writeText(detail.value)}
                className="ml-auto shrink-0 text-xs text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-2 py-0.5"
                title="Copy value to clipboard"
              >
                Copy
              </button>
              <button
                onClick={() => setDetail(null)}
                className="shrink-0 text-zinc-400 hover:text-white text-lg leading-none"
                title="Close (Esc)"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {detail.value}
            </pre>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
          onClick={() => {
            if (!deleting) setConfirmDelete(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm delete"
            className="flex flex-col w-full max-w-md bg-zinc-900 border border-red-900/50 rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-medium text-zinc-100">
              Delete this {deleteObject} record?
            </div>

            <div className="flex flex-col gap-2 px-4 py-3 text-xs text-zinc-300">
              {confirmDelete.label &&
                confirmDelete.label !== confirmDelete.recordId && (
                  <div className="truncate" title={confirmDelete.label}>
                    {confirmDelete.label}
                  </div>
                )}
              <div className="font-mono text-zinc-400">
                {confirmDelete.recordId}
              </div>
              <div className="text-amber-400/90">
                Deletes it in org{" "}
                <span className="font-mono">{deleteOrg}</span>
                {resultContext?.useToolingApi ? " via the Tooling API" : ""}.
                Most objects land in the org's Recycle Bin; some are gone for
                good.
              </div>
              {deleteError && (
                <div className="max-h-40 overflow-auto rounded border border-red-900/50 bg-red-950/40 p-2 font-mono text-red-300 whitespace-pre-wrap break-words">
                  {deleteError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-zinc-800">
              <button
                autoFocus
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="text-xs text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-3 py-1 disabled:opacity-50"
                title="Close without deleting (Esc)"
              >
                Cancel
              </button>
              <button
                onClick={() => void doDelete()}
                disabled={deleting}
                className="flex items-center gap-1.5 text-xs text-white bg-red-700 hover:bg-red-600 rounded px-3 py-1 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {deleting && <Spinner />}
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
