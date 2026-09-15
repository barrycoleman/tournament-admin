import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  DataGrid,
  renderTextEditor,
  type Column,
  type RenderEditCellProps,
  type RowsChangeData,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { showTransientError } from "../errorBanner";
import type { Division } from "../types";
import { makeBlankTeamRow, type TeamGridRow } from "../teamCsv";

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
  return [...merged, ...brandNew];
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
  return result;
}

function DivisionEditor(
  props: RenderEditCellProps<TeamGridRow> & { divisions: Division[]; unassignedLabel: string }
) {
  const { row, onRowChange, onClose, divisions, unassignedLabel } = props;
  return (
    <select
      autoFocus
      value={row.division}
      onChange={(event) => {
        onRowChange({ ...row, division: event.target.value, dirty: true }, true);
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
    </select>
  );
}

export function TeamsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [allRows, setAllRows] = useState<TeamGridRow[]>([]);
  const [divisionFilter, setDivisionFilter] = useState<string>("");
  const [saveSummary, setSaveSummary] = useState<{ saved: number; failed: number } | null>(null);

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
        renderEditCell: (props) => (
          <DivisionEditor
            {...props}
            divisions={divisions ?? []}
            unassignedLabel={t("teams.unassigned")}
          />
        ),
      });
    }
    base.push({
      key: "__status",
      name: t("teams.columnStatus"),
      renderCell: ({ row }) => {
        if (row.error) return <span style={{ color: "crimson" }}>{row.error}</span>;
        if (row.dirty) return <span>{t("teams.unsavedIndicator")}</span>;
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
    // is idempotent for it.
    const touchedIndexes = new Set(data.indexes);
    const touched = updatedVisible.map((row, index) =>
      touchedIndexes.has(index) ? { ...row, dirty: true } : row
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

  async function handleSave() {
    const dirtyRows = allRows.filter((row) => row.dirty);
    if (dirtyRows.length === 0) return;
    const body = {
      rows: dirtyRows.map((row) => ({
        number: row.number,
        name: row.name,
        robot_name: row.robot_name || null,
        organization: row.organization || null,
        city: row.city || null,
        state: row.state || null,
        country: row.country || null,
        division: row.division || null,
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
      // dirty row stays dirty. The per-row `error` column only ever
      // carries per-row rejections from a request that did succeed, so
      // this has to go to the shell's transient banner instead.
      showTransientError(err instanceof ApiError ? err.detail : t("errors.network"));
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
    setAllRows((previous) => previous.map((row) => updatedById.get(row.clientId) ?? row));
    setSaveSummary({ saved, failed });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
    queryClient.invalidateQueries({ queryKey: ["divisions"] });
  }

  const hasUnsavedChanges = allRows.some((row) => row.dirty);

  return (
    <div>
      <h1>{t("teams.heading")}</h1>
      {showDivisionColumn && (
        <div>
          <label htmlFor="division-filter">{t("teams.divisionFilterLabel")}</label>
          <select
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

      <div>
        <button onClick={handleAddRow}>{t("teams.addRow")}</button>
        <button onClick={() => void handleSave()} disabled={!hasUnsavedChanges}>
          {t("teams.saveChanges")}
        </button>
      </div>

      {saveSummary && (
        <p role="status">
          {saveSummary.failed > 0
            ? t("teams.saveSummary", { saved: saveSummary.saved, failed: saveSummary.failed })
            : t("teams.saveSummaryAllOk", { saved: saveSummary.saved })}
        </p>
      )}

      <DataGrid
        columns={columns}
        rows={visibleRows}
        rowKeyGetter={(row) => row.clientId}
        onRowsChange={handleRowsChange}
      />
    </div>
  );
}
