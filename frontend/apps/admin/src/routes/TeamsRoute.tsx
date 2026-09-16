import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  DataGrid,
  renderTextEditor,
  type CellPasteArgs,
  type Column,
  type RenderEditCellProps,
  type RowsChangeData,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { showTransientError } from "../errorBanner";
import type { Division } from "../types";
import {
  BLANK_TEAM_CSV_TEMPLATE,
  TEAM_FIELD_KEYS,
  downloadCsv,
  expandPastedBlock,
  makeBlankTeamRow,
  parseCsvFile,
  teamsToCsv,
  type TeamGridRow,
} from "../teamCsv";

const RANDOM_DIVISION_SENTINEL = "__random__";

interface TeamApiRow {
  id: number;
  number: string;
  name: string;
  robot_name: string | null;
  organization: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  division_id: number | null;
}

interface TeamBulkRowResult {
  row_index: number;
  status: "created" | "updated" | "error";
  team: TeamApiRow | null;
  error: string | null;
}

function toGridRow(team: TeamApiRow, divisionNameById: Map<number, string>): TeamGridRow {
  return {
    clientId: `server-${team.id}`,
    id: team.id,
    number: team.number,
    name: team.name,
    robot_name: team.robot_name ?? "",
    organization: team.organization ?? "",
    city: team.city ?? "",
    state: team.state ?? "",
    country: team.country ?? "",
    division: team.division_id !== null ? (divisionNameById.get(team.division_id) ?? "") : "",
    dirty: false,
  };
}

/**
 * `clientId` is the grid's React key AND the key every merge in this file
 * matches on, so `allRows` must never hold two rows with the same one --
 * if it does, editing either rewrites both.
 *
 * The roster can genuinely arrive at a collision, because
 * `/api/teams/bulk` upserts by team NUMBER, not by `clientId`: type an
 * already-taken number into a brand-new row (or, once CSV upload lands,
 * re-upload a corrected roster that still contains an existing team) and
 * the server reports an *update* to the existing team. `handleSave` then
 * stamps that team's `server-<id>` onto the new row while the original
 * row carrying the same id is still in the array.
 *
 * Collapse those to one row, keeping the occurrence that holds state the
 * user would otherwise lose: a server-reported `error` first, then an
 * unsaved edit, then whichever came first. The kept row keeps its
 * position. When both are clean (the just-saved case) either copy is
 * equally valid -- the refetch that follows every save reconciles the
 * survivor's fields against the server anyway.
 */
export function dedupeByClientId(rows: TeamGridRow[]): TeamGridRow[] {
  const keepPriority = (row: TeamGridRow) => (row.error ? 2 : row.dirty ? 1 : 0);
  const positionByClientId = new Map<string, number>();
  const result: TeamGridRow[] = [];
  for (const row of rows) {
    const existingPosition = positionByClientId.get(row.clientId);
    if (existingPosition === undefined) {
      positionByClientId.set(row.clientId, result.length);
      result.push(row);
    } else if (keepPriority(row) > keepPriority(result[existingPosition])) {
      result[existingPosition] = row;
    }
  }
  return result;
}

/**
 * Fold the rows react-data-grid hands back (which are only the *visible*,
 * possibly division-filtered, rows) into the full unfiltered roster.
 * Rows are matched by `clientId`; changed rows replace their counterpart
 * in place and brand-new rows are appended. Never assign the grid's rows
 * straight to `allRows` — that would silently drop every row outside the
 * active filter.
 */
export function mergeRows(all: TeamGridRow[], updatedVisible: TeamGridRow[]): TeamGridRow[] {
  const updatedById = new Map(updatedVisible.map((row) => [row.clientId, row]));
  const existingIds = new Set(all.map((row) => row.clientId));
  const merged = all.map((row) => updatedById.get(row.clientId) ?? row);
  const brandNew = updatedVisible.filter((row) => !existingIds.has(row.clientId));
  return dedupeByClientId([...merged, ...brandNew]);
}

/**
 * Re-derive the roster from a fresh server fetch while keeping every
 * locally-dirty row intact. A refetch fires right after "Save changes"
 * (and on any background invalidation), and rows that came back from the
 * bulk endpoint with a per-row error are still dirty and still only exist
 * locally — blindly replacing state with the server list would throw away
 * exactly the rows the user still has to fix. Row order is preserved.
 */
export function mergeServerRows(
  previous: TeamGridRow[],
  serverRows: TeamGridRow[]
): TeamGridRow[] {
  const serverById = new Map(serverRows.map((row) => [row.clientId, row]));
  const consumed = new Set<string>();
  const result: TeamGridRow[] = [];
  for (const row of previous) {
    if (row.dirty) {
      result.push(row);
      consumed.add(row.clientId);
      continue;
    }
    const fromServer = serverById.get(row.clientId);
    if (fromServer) {
      result.push(fromServer);
      consumed.add(row.clientId);
    }
    // A clean local row the server no longer knows about was deleted
    // elsewhere; drop it.
  }
  for (const row of serverRows) {
    if (!consumed.has(row.clientId)) {
      result.push(row);
    }
  }
  // `previous` can already carry a collision the save round trip just
  // created (see dedupeByClientId); don't propagate it.
  return dedupeByClientId(result);
}

/**
 * Reconcile freshly-parsed CSV rows against the roster already in the grid,
 * matching by team number (trimmed, same as the backend's own upsert
 * matching) rather than blind-appending. A number with no existing match is
 * a brand-new row. A number that already exists is merged onto that row in
 * place -- re-uploading a roster that overlaps what's already loaded must
 * not produce a second row for the same team, the way a plain append would.
 * When every field is identical to what's already there (re-uploading the
 * same file twice, or a file re-saved with no edits) the existing row is
 * left completely alone: not marked dirty, not touched at all.
 */
export function reconcileUploadedRows(
  existing: TeamGridRow[],
  uploaded: TeamGridRow[]
): TeamGridRow[] {
  const indexByNumber = new Map(existing.map((row, index) => [row.number.trim(), index]));
  const result = [...existing];
  for (const uploadedRow of uploaded) {
    const matchIndex = indexByNumber.get(uploadedRow.number.trim());
    if (matchIndex === undefined) {
      result.push(uploadedRow);
      continue;
    }
    const match = result[matchIndex];
    const changed = TEAM_FIELD_KEYS.some((key) => match[key] !== uploadedRow[key]);
    if (!changed) continue;
    const merged = { ...match };
    for (const key of TEAM_FIELD_KEYS) {
      merged[key] = uploadedRow[key];
    }
    result[matchIndex] = { ...merged, dirty: true, error: undefined };
  }
  return result;
}

function DivisionEditor(
  props: RenderEditCellProps<TeamGridRow> & {
    divisions: Division[];
    unassignedLabel: string;
    randomLabel: string;
  }
) {
  const { row, onRowChange, onClose, divisions, unassignedLabel, randomLabel } = props;
  return (
    <select
      autoFocus
      value={row.division}
      onChange={(event) => {
        onRowChange(
          { ...row, division: event.target.value, dirty: true, error: undefined },
          true
        );
        onClose(true);
      }}
      onBlur={() => onClose(true)}
    >
      <option value="">{unassignedLabel}</option>
      {divisions.map((division) => (
        <option key={division.id} value={division.name}>
          {division.name}
        </option>
      ))}
      {row.id === null && <option value={RANDOM_DIVISION_SENTINEL}>{randomLabel}</option>}
    </select>
  );
}

export function TeamsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [allRows, setAllRows] = useState<TeamGridRow[]>([]);
  const [divisionFilter, setDivisionFilter] = useState<string>("");
  const [saveSummary, setSaveSummary] = useState<{ saved: number; failed: number } | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<TeamGridRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [randomizeError, setRandomizeError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // `saving` drives the button's disabled state; `savingRef` is what the
  // in-flight guard actually reads. A `useState` flag alone can't stop a
  // double submit: two clicks dispatched before React re-renders run the
  // same closure, which still sees the pre-click `saving === false`.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamApiRow[]>("/api/teams"),
  });

  useEffect(() => {
    if (!teams || !divisions) return;
    const divisionNameById = new Map(divisions.map((division) => [division.id, division.name]));
    const serverRows = teams.map((team) => toGridRow(team, divisionNameById));
    setAllRows((previous) => mergeServerRows(previous, serverRows));
    // Only re-derive from the server when the underlying query data
    // actually changes -- local edits between refetches must not be
    // clobbered by this effect re-running for unrelated reasons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams, divisions]);

  const visibleRows = useMemo(
    () => (divisionFilter ? allRows.filter((row) => row.division === divisionFilter) : allRows),
    [allRows, divisionFilter]
  );

  const showDivisionColumn = (divisions?.length ?? 0) > 1;

  const columns: Column<TeamGridRow>[] = useMemo(() => {
    // react-data-grid only treats a column as editable when it has a
    // `renderEditCell` -- `editable: true` on its own is inert despite what
    // the prop's name suggests -- so every text column gets the library's
    // own plain-text editor explicitly.
    const textColumn = (key: string, name: string): Column<TeamGridRow> => ({
      key,
      name,
      editable: true,
      renderEditCell: renderTextEditor,
    });
    const base: Column<TeamGridRow>[] = [
      textColumn("number", t("teams.columnNumber")),
      textColumn("name", t("teams.columnName")),
      textColumn("robot_name", t("teams.columnRobotName")),
      textColumn("organization", t("teams.columnOrganization")),
      textColumn("city", t("teams.columnCity")),
      textColumn("state", t("teams.columnState")),
      textColumn("country", t("teams.columnCountry")),
    ];
    if (showDivisionColumn) {
      base.push({
        key: "division",
        name: t("teams.columnDivision"),
        renderCell: ({ row }) =>
          row.division === RANDOM_DIVISION_SENTINEL
            ? t("teams.randomDivisionOption")
            : row.division,
        renderEditCell: (props) => (
          <DivisionEditor
            {...props}
            divisions={divisions ?? []}
            unassignedLabel={t("teams.unassigned")}
            randomLabel={t("teams.randomDivisionOption")}
          />
        ),
      });
    }
    base.push({
      key: "__delete",
      name: "",
      renderCell: ({ row }) => (
        <button
          aria-label={t("teams.deleteAction")}
          onClick={() => {
            setDeleteError(null);
            setDeleteCandidate(row);
          }}
        >
          {t("teams.deleteAction")}
        </button>
      ),
    });
    base.push({
      key: "__status",
      name: t("teams.columnStatus"),
      renderCell: ({ row }) => {
        if (row.error) return <span className="badge badge-danger">{row.error}</span>;
        if (row.dirty) return <span className="badge badge-warning">{t("teams.unsavedIndicator")}</span>;
        return null;
      },
    });
    return base;
  }, [t, showDivisionColumn, divisions]);

  function handleRowsChange(
    updatedVisible: TeamGridRow[],
    data: RowsChangeData<TeamGridRow>
  ) {
    // react-data-grid's built-in text editor (used by every `editable: true`
    // column) writes the new value straight onto the row and knows nothing
    // about our `dirty` flag, so mark the rows it reports as changed here.
    // The division column's custom editor already sets `dirty` itself; this
    // is idempotent for it. Editing a row also clears any per-row `error`
    // left over from a previous save -- that error described the value the
    // user has now changed, so leaving it up would be stale and would hide
    // the "unsaved" indicator for a row that really does have unsaved work.
    const touchedIndexes = new Set(data.indexes);
    const touched = updatedVisible.map((row, index) =>
      touchedIndexes.has(index) ? { ...row, dirty: true, error: undefined } : row
    );
    setAllRows((previous) => mergeRows(previous, touched));
  }

  function handleAddRow() {
    const blank = makeBlankTeamRow();
    if (divisionFilter) {
      blank.division = divisionFilter;
    }
    setAllRows((previous) => [...previous, blank]);
  }

  const randomizeMutation = useMutation({
    mutationFn: () =>
      apiRequest<TeamApiRow[]>("/api/divisions/randomize", {
        method: "POST",
        body: { scope: "unassigned" },
      }),
    onSuccess: () => {
      setRandomizeError(null);
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (err) => {
      setRandomizeError(err instanceof ApiError ? err.detail : t("errors.generic"));
    },
  });

  function handleDownloadCsv() {
    // `__random__` is a UI-only sentinel for "pick a division for me on
    // save"; it is not a division name and must never reach the exported
    // file (which is also a valid re-upload input).
    const exportRows = visibleRows.map((row) =>
      row.division === RANDOM_DIVISION_SENTINEL ? { ...row, division: "" } : row
    );
    downloadCsv("teams.csv", teamsToCsv(exportRows));
  }

  function handleDownloadTemplate() {
    downloadCsv("teams-template.csv", BLANK_TEAM_CSV_TEMPLATE);
  }

  // Bypasses `handleRowsChange` entirely: `expandPastedBlock` already marks
  // every row it touches `dirty: true` itself, and it can grow the row
  // count past what's currently visible (appending new blank rows), which
  // `handleRowsChange` -- built for react-data-grid's own single-cell edit
  // commits -- isn't shaped for. `mergeRows` still does the merge-not-replace
  // fold back into `allRows` so rows outside the current division filter
  // survive.
  function handleCellPaste(
    args: CellPasteArgs<TeamGridRow>,
    event: ClipboardEvent<HTMLDivElement>
  ): TeamGridRow {
    const text = event.clipboardData.getData("text/plain");
    const rowIndex = visibleRows.findIndex((row) => row.clientId === args.row.clientId);
    if (rowIndex === -1) {
      return args.row;
    }
    const expanded = expandPastedBlock(text, visibleRows, rowIndex, args.column.key);
    setAllRows((prev) => mergeRows(prev, expanded));
    return args.row;
  }

  function handleCsvFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const parsedRows = parseCsvFile(text);
      setAllRows((prev) => reconcileUploadedRows(prev, parsedRows));
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  async function handleSave() {
    // A second click while the first request is still in flight would send
    // the same dirty rows twice; the endpoint upserts by number, so the
    // duplicate request races the first one's row creation. Guard on a
    // flag rather than on the mutation state because this is a plain async
    // function, not a `useMutation`.
    if (savingRef.current) return;
    setSaveSummary(null);
    setSaveError(null);
    const dirtyRows = allRows.filter((row) => row.dirty);
    if (dirtyRows.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const body = {
        rows: dirtyRows.map((row) => ({
          number: row.number,
          name: row.name,
          robot_name: row.robot_name || null,
          organization: row.organization || null,
          city: row.city || null,
          state: row.state || null,
          country: row.country || null,
          division: row.division === RANDOM_DIVISION_SENTINEL ? null : row.division || null,
          assign_random_division: row.division === RANDOM_DIVISION_SENTINEL,
        })),
      };
      let response: { results: TeamBulkRowResult[] };
      try {
        response = await apiRequest<{ results: TeamBulkRowResult[] }>("/api/teams/bulk", {
          method: "POST",
          body,
        });
      } catch (err) {
        // The request as a whole failed, so nothing was saved and every
        // dirty row stays dirty. A domain error the server reported gets
        // an inline message next to the Save button, matching every other
        // mutation on this screen; only a genuine transport failure goes
        // to the shell's transient banner, which `errorBanner.ts` reserves
        // for background query failures.
        if (err instanceof ApiError) {
          setSaveError(err.detail);
        } else {
          showTransientError(t("errors.network"));
        }
        return;
      }
      const byIndex = new Map(response.results.map((result) => [result.row_index, result]));
      const updatedById = new Map<string, TeamGridRow>();
      let saved = 0;
      let failed = 0;
      dirtyRows.forEach((row, index) => {
        const result = byIndex.get(index);
        if (!result) return;
        if (result.status === "error") {
          failed += 1;
          updatedById.set(row.clientId, { ...row, error: result.error ?? undefined });
        } else if (result.team) {
          saved += 1;
          updatedById.set(row.clientId, {
            ...row,
            clientId: `server-${result.team.id}`,
            id: result.team.id,
            dirty: false,
            error: undefined,
          });
        }
      });
      // A row that was new locally can come back as an *update* to an
      // existing team (the endpoint upserts by number), which stamps a
      // `server-<id>` already held by another row onto it -- dedupe before
      // this reaches the grid.
      setAllRows((previous) =>
        dedupeByClientId(previous.map((row) => updatedById.get(row.clientId) ?? row))
      );
      setSaveSummary({ saved, failed });
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["divisions"] });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteCandidate) return;
    // A row that was never saved only exists locally, so "delete" is just
    // dropping it from state -- there is nothing on the server to call.
    if (deleteCandidate.id === null) {
      setAllRows((prev) => prev.filter((row) => row.clientId !== deleteCandidate.clientId));
      setDeleteCandidate(null);
      return;
    }
    setDeleteError(null);
    try {
      await apiRequest<void>(`/api/teams/${deleteCandidate.id}`, { method: "DELETE" });
      setAllRows((prev) => prev.filter((row) => row.clientId !== deleteCandidate.clientId));
      setDeleteCandidate(null);
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.detail : t("errors.generic"));
    }
  }

  const hasUnsavedChanges = allRows.some((row) => row.dirty);
  const hasUnassignedTeams = allRows.some((row) => row.id !== null && row.division === "");
  const canRandomize = hasUnassignedTeams && (divisions?.length ?? 0) > 1;

  return (
    <div>
      <h1>{t("teams.heading")}</h1>
      {showDivisionColumn && (
        <div className="field" style={{ maxWidth: 280 }}>
          <label className="field__label" htmlFor="division-filter">
            {t("teams.divisionFilterLabel")}
          </label>
          <select
            className="select"
            id="division-filter"
            value={divisionFilter}
            onChange={(event) => setDivisionFilter(event.target.value)}
          >
            <option value="">{t("teams.divisionFilterAll")}</option>
            {divisions?.map((division) => (
              <option key={division.id} value={division.name}>
                {division.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="toolbar">
        <button className="btn" onClick={handleAddRow}>
          {t("teams.addRow")}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void handleSave()}
          disabled={!hasUnsavedChanges || saving}
        >
          {t("teams.saveChanges")}
        </button>
        <label className="btn" htmlFor="csv-upload" style={{ cursor: "pointer" }}>
          {t("teams.uploadCsvLabel")}
        </label>
        <input
          id="csv-upload"
          type="file"
          accept=".csv"
          onChange={handleCsvFileSelected}
          style={{ display: "none" }}
        />
        <button className="btn" onClick={handleDownloadCsv}>
          {t("teams.downloadCsvLabel")}
        </button>
        <button className="btn" onClick={handleDownloadTemplate}>
          {t("teams.downloadTemplateLabel")}
        </button>
        <button
          className="btn"
          onClick={() => randomizeMutation.mutate()}
          disabled={!canRandomize || randomizeMutation.isPending}
        >
          {t("teams.randomizeUnassignedAction")}
        </button>
      </div>
      {randomizeError && (
        <p className="alert alert-danger" role="alert">
          {randomizeError}
        </p>
      )}
      {saveError && (
        <p className="alert alert-danger" role="alert">
          {saveError}
        </p>
      )}

      {saveSummary && (
        <p className="alert alert-success" role="status">
          {saveSummary.failed > 0
            ? t("teams.saveSummary", { saved: saveSummary.saved, failed: saveSummary.failed })
            : t("teams.saveSummaryAllOk", { saved: saveSummary.saved })}
        </p>
      )}

      <DataGrid
        aria-label={t("teams.gridLabel")}
        columns={columns}
        rows={visibleRows}
        rowKeyGetter={(row) => row.clientId}
        onRowsChange={handleRowsChange}
        onCellPaste={handleCellPaste}
      />

      {deleteCandidate && (
        <div className="dialog-overlay">
          <div className="dialog" role="alertdialog" aria-labelledby="delete-team-heading">
            <h2 id="delete-team-heading">{t("teams.deleteConfirmHeading")}</h2>
            <p>{t("teams.deleteConfirmBody")}</p>
            {deleteError && (
              <p className="alert alert-danger" role="alert">
                {deleteError}
              </p>
            )}
            <div className="dialog__actions">
              <button className="btn btn-danger" onClick={() => void handleConfirmDelete()}>
                {t("teams.deleteAction")}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setDeleteCandidate(null);
                  setDeleteError(null);
                }}
              >
                {t("teams.cancelAction")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
