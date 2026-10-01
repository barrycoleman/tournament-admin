import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { DataGrid, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { Division, SessionRead } from "../types";

interface TeamApiRow {
  id: number;
  number: string;
  name: string;
  division_id: number | null;
}

interface ParticipationApiRow {
  id: number;
  session_id: number;
  team_id: number;
  checked_in: boolean;
}

interface CheckinGridRow {
  id: number;
  number: string;
  name: string;
  division: string;
  checkedIn: boolean;
}

export function SessionCheckinRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const [filterText, setFilterText] = useState("");

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamApiRow[]>("/api/teams"),
  });
  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: participants } = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () =>
      apiRequest<ParticipationApiRow[]>(`/api/sessions/${session.id}/participants`),
  });

  const divisionNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const division of divisions ?? []) map.set(division.id, division.name);
    return map;
  }, [divisions]);

  const checkedInByTeamId = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const participation of participants ?? []) {
      map.set(participation.team_id, participation.checked_in);
    }
    return map;
  }, [participants]);

  const allRows: CheckinGridRow[] = useMemo(
    () =>
      (teams ?? []).map((team) => ({
        id: team.id,
        number: team.number,
        name: team.name,
        division: team.division_id !== null ? (divisionNameById.get(team.division_id) ?? "") : "",
        checkedIn: checkedInByTeamId.get(team.id) ?? false,
      })),
    [teams, divisionNameById, checkedInByTeamId]
  );

  const filteredRows = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return allRows;
    return allRows.filter(
      (row) => row.number.toLowerCase().includes(query) || row.name.toLowerCase().includes(query)
    );
  }, [allRows, filterText]);

  const sortedRows = useMemo(
    () =>
      [...filteredRows].sort((a, b) =>
        a.division !== b.division
          ? a.division.localeCompare(b.division)
          : a.number.localeCompare(b.number, undefined, { numeric: true })
      ),
    [filteredRows]
  );

  const toggleMutation = useMutation({
    mutationFn: ({ teamId, checkedIn }: { teamId: number; checkedIn: boolean }) =>
      apiRequest(`/api/sessions/${session.id}/participants`, {
        method: "POST",
        body: { team_id: teamId, checked_in: checkedIn },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["participants", session.id] });
    },
  });

  const bulkMutation = useMutation({
    mutationFn: async (checkedIn: boolean) => {
      // Promise.allSettled, not Promise.all: Promise.all rejects (and
      // stops waiting) on the FIRST failure, abandoning whatever writes
      // already succeeded with no cache refresh for them. Settling every
      // request first, then invalidating in onSettled below (not
      // onSuccess), means rows that did succeed are still reflected even
      // if one of the others failed.
      const results = await Promise.allSettled(
        sortedRows.map((row) =>
          apiRequest(`/api/sessions/${session.id}/participants`, {
            method: "POST",
            body: { team_id: row.id, checked_in: checkedIn },
          })
        )
      );
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (firstFailure) {
        throw firstFailure.reason;
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["participants", session.id] });
    },
  });

  const showDivisionColumn = (divisions?.length ?? 0) > 1;

  const columns: Column<CheckinGridRow>[] = useMemo(() => {
    const base: Column<CheckinGridRow>[] = [
      { key: "number", name: t("sessions.checkin.columnNumber") },
      { key: "name", name: t("sessions.checkin.columnName") },
    ];
    if (showDivisionColumn) {
      base.push({ key: "division", name: t("sessions.checkin.columnDivision") });
    }
    base.push({
      key: "checkedIn",
      name: t("sessions.checkin.columnCheckedIn"),
      renderCell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={t("sessions.checkin.toggleAction", { name: row.name })}
          checked={row.checkedIn}
          onChange={(event) =>
            toggleMutation.mutate({ teamId: row.id, checkedIn: event.target.checked })
          }
        />
      ),
    });
    return base;
  }, [t, showDivisionColumn, toggleMutation]);

  return (
    <div>
      <div className="form-actions">
        <input
          className="input"
          placeholder={t("sessions.checkin.filterPlaceholder")}
          aria-label={t("sessions.checkin.filterPlaceholder")}
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
        />
        <button className="btn btn-small" onClick={() => bulkMutation.mutate(true)}>
          {t("sessions.checkin.checkInAllVisible")}
        </button>
        <button className="btn btn-small" onClick={() => bulkMutation.mutate(false)}>
          {t("sessions.checkin.checkOutAllVisible")}
        </button>
      </div>
      {bulkMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {bulkMutation.error instanceof ApiError ? bulkMutation.error.detail : t("errors.generic")}
        </p>
      )}
      {toggleMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {toggleMutation.error instanceof ApiError ? toggleMutation.error.detail : t("errors.generic")}
        </p>
      )}
      <DataGrid columns={columns} rows={sortedRows} rowKeyGetter={(row) => row.id} />
    </div>
  );
}
