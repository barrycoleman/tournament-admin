import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import { DataGrid, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest } from "@tournament-admin/shared";
import { formatMatchTime, spansMultipleDays } from "../matchTime";
import { useSessionMatches } from "../useSessionMatches";
import type { Division, FieldRead, SessionRead, TeamSummary } from "../types";

interface MatchGridRow {
  id: number;
  label: string;
  time: string;
  field: string;
  status: string;
  alliances: Record<string, string>;
}

const NO_TIME_SORT_KEY = "￿";

export function SessionMatchesRoute() {
  const { t, i18n } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [divisionFilter, setDivisionFilter] = useState("");
  const [roundFilter, setRoundFilter] = useState("");
  const [teamQuery, setTeamQuery] = useState("");

  const { data: matches, isLoading } = useSessionMatches(session.id);
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const { data: fields } = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });

  const allMatches = useMemo(() => matches ?? [], [matches]);
  const teamById = useMemo(() => new Map((teams ?? []).map((team) => [team.id, team])), [teams]);
  const fieldNameById = useMemo(
    () => new Map((fields ?? []).map((field) => [field.id, field.name])),
    [fields]
  );
  const stations = useMemo(() => {
    const seen: string[] = [];
    for (const match of allMatches) {
      for (const alliance of match.alliances) {
        if (!seen.includes(alliance.station)) seen.push(alliance.station);
      }
    }
    return seen;
  }, [allMatches]);
  const roundTypes = useMemo(() => [...new Set(allMatches.map((m) => m.round_type))], [allMatches]);
  const includeDate = useMemo(
    () =>
      spansMultipleDays(
        allMatches.flatMap((m) => (m.scheduled_time ? [m.scheduled_time] : [])),
        session.timezone
      ),
    [allMatches, session.timezone]
  );

  const rows = useMemo(() => {
    const query = teamQuery.trim().toLowerCase();
    const teamMatches = (teamId: number) => {
      const team = teamById.get(teamId);
      return team !== undefined && (team.number.toLowerCase().includes(query) || team.name.toLowerCase().includes(query));
    };
    return allMatches
      .filter((m) => divisionFilter === "" || String(m.division_id) === divisionFilter)
      .filter((m) => roundFilter === "" || m.round_type === roundFilter)
      .filter((m) => !query || m.alliances.some((a) => a.team_ids.some(teamMatches)))
      .sort((a, b) => {
        const aTime = a.scheduled_time ?? NO_TIME_SORT_KEY;
        const bTime = b.scheduled_time ?? NO_TIME_SORT_KEY;
        if (aTime !== bTime) return aTime.localeCompare(bTime);
        return a.label.localeCompare(b.label, undefined, { numeric: true });
      })
      .map(
        (m): MatchGridRow => ({
          id: m.id,
          label: m.label,
          time: m.scheduled_time
            ? formatMatchTime(m.scheduled_time, session.timezone, includeDate, i18n.language)
            : t("sessions.matches.noTime"),
          field: m.field_id !== null ? (fieldNameById.get(m.field_id) ?? "") : "",
          status: m.status,
          alliances: Object.fromEntries(
            m.alliances.map((a) => [
              a.station,
              a.team_ids.map((id) => teamById.get(id)?.number ?? String(id)).join(", "),
            ])
          ),
        })
      );
  }, [allMatches, divisionFilter, roundFilter, teamQuery, teamById, fieldNameById, session.timezone, includeDate, i18n.language, t]);

  const columns: Column<MatchGridRow>[] = useMemo(
    () => [
      { key: "label", name: t("sessions.matches.columnMatch") },
      { key: "time", name: t("sessions.matches.columnTime") },
      { key: "field", name: t("sessions.matches.columnField") },
      ...stations.map(
        (station): Column<MatchGridRow> => ({
          key: `station:${station}`,
          name: station,
          renderCell: ({ row }) => row.alliances[station] ?? "",
        })
      ),
      {
        key: "status",
        name: t("sessions.matches.columnStatus"),
        renderCell: ({ row }) => t(`sessions.matches.status.${row.status}`, { defaultValue: row.status }),
      },
    ],
    [t, stations]
  );

  if (isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }

  if (allMatches.length === 0) {
    return (
      <div className="panel">
        <p>{t("sessions.matches.empty")}</p>
        <Link to={`/sessions/${session.id}/schedule`}>{t("sessions.matches.goToSchedule")}</Link>
      </div>
    );
  }

  const multiDivision = (divisions?.length ?? 0) > 1;

  return (
    <div>
      <div className="form-actions">
        {multiDivision && (
          <label className="field">
            <span className="field__label">{t("sessions.matches.divisionFilterLabel")}</span>
            <select className="select" value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
              <option value="">{t("sessions.matches.allDivisions")}</option>
              {(divisions ?? []).map((division) => (
                <option key={division.id} value={division.id}>
                  {division.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="field__label">{t("sessions.matches.roundFilterLabel")}</span>
          <select className="select" value={roundFilter} onChange={(e) => setRoundFilter(e.target.value)}>
            <option value="">{t("sessions.matches.allRounds")}</option>
            {roundTypes.map((roundType) => (
              <option key={roundType} value={roundType}>
                {roundType}
              </option>
            ))}
          </select>
        </label>
        <input
          className="input"
          aria-label={t("sessions.matches.teamSearchLabel")}
          placeholder={t("sessions.matches.teamSearchLabel")}
          value={teamQuery}
          onChange={(e) => setTeamQuery(e.target.value)}
        />
      </div>
      <DataGrid columns={columns} rows={rows} rowKeyGetter={(row) => row.id} />
    </div>
  );
}
