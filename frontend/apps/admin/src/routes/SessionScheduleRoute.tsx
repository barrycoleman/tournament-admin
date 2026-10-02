import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { ReadinessChecklist } from "../schedule/ReadinessChecklist";
import { CurrentRounds } from "../schedule/CurrentRounds";
import { OutOfScopeRounds } from "../schedule/OutOfScopeRounds";
import { ScheduleForm } from "../schedule/ScheduleForm";
import { checkReadiness, countCheckedInTeams, countUsableFields } from "../schedule/readiness";
import { summarizeOutOfScopeRounds, summarizeRounds } from "../schedule/roundSummary";
import { useSessionMatches } from "../useSessionMatches";
import type {
  Division,
  EventRead,
  FieldRead,
  FieldSetRead,
  MatchFormat,
  ParticipationRead,
  ScheduleGenerateResponse,
  SessionRead,
  TeamSummary,
} from "../types";

export function SessionScheduleRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [selectedDivisionId, setSelectedDivisionId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const [lastGenerated, setLastGenerated] = useState<ScheduleGenerateResponse | null>(null);

  const { data: divisions, isError: divisionsError } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const { data: matchFormat, isError: matchFormatError } = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<MatchFormat>("/api/event/match-format"),
    enabled: Boolean(event?.game_plugin_name),
  });
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const { data: participants } = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () => apiRequest<ParticipationRead[]>(`/api/sessions/${session.id}/participants`),
  });
  const { data: fieldSets } = useQuery({
    queryKey: ["fieldSets", session.id],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${session.id}`),
  });
  const { data: fields } = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const { data: matches } = useSessionMatches(session.id);

  // Until the divisions load we cannot tell single- from multi-division, and
  // rendering as single-division would briefly show unscoped data.
  if (divisionsError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (divisions === undefined) return null;

  // A single-division event schedules with no division_id at all: the
  // backend then uses unassigned FieldSets and the sole division's teams.
  const multiDivision = (divisions?.length ?? 0) > 1;
  const divisionId = multiDivision ? (selectedDivisionId ?? divisions![0].id) : null;

  const rounds = summarizeRounds(matches ?? [], divisionId);
  const readiness = checkReadiness({
    gamePluginSelected: Boolean(event?.game_plugin_name),
    sessionTimezone: session.timezone,
    checkedInTeamCount: countCheckedInTeams(teams ?? [], participants ?? [], divisionId),
    teamsNeeded: matchFormat ? matchFormat.teams_per_alliance * matchFormat.alliance_count : 0,
    usableFieldCount: countUsableFields(fieldSets ?? [], fields ?? [], divisionId),
  });
  const ready = readiness.every((item) => item.ok);
  // The server's conflict check counts every match of a round type in the
  // scope, finals included, so the form must avoid those types too even
  // though Current Rounds leaves finals out.
  const existingRoundTypes = [
    ...new Set(
      (matches ?? []).filter((match) => match.division_id === divisionId).map((match) => match.round_type)
    ),
  ];
  const outOfScopeRounds = summarizeOutOfScopeRounds(matches ?? [], multiDivision);

  return (
    <div className="session-schedule">
      {multiDivision && (
        <label className="field">
          <span className="field__label">{t("sessions.schedule.divisionLabel")}</span>
          <select
            className="select"
            value={divisionId ?? ""}
            onChange={(event) => setSelectedDivisionId(Number(event.target.value))}
          >
            {(divisions ?? []).map((division) => (
              <option key={division.id} value={division.id}>
                {division.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ReadinessChecklist items={readiness} sessionId={session.id} />
      <OutOfScopeRounds sessionId={session.id} divisions={divisions} rounds={outOfScopeRounds} />
      <CurrentRounds
        sessionId={session.id}
        divisionId={divisionId}
        sessionTimezone={session.timezone}
        rounds={rounds}
      />
      {lastGenerated && (
        <p className="alert alert-success" role="status">
          {t("sessions.schedule.form.generated", { count: lastGenerated.match_count })}{" "}
          <Link to={`/sessions/${session.id}/matches`}>{t("sessions.schedule.form.viewMatches")}</Link>
        </p>
      )}
      {matchFormat ? (
        <ScheduleForm
          // Remounting on the existing round types (and division) resets
          // the form after a Generate or Clear lands, so it never offers a
          // round type that now has a schedule.
          key={`${divisionId ?? "none"}:${existingRoundTypes.join(",")}`}
          sessionId={session.id}
          divisionId={divisionId}
          session={session}
          matchFormat={matchFormat}
          existingRoundTypes={existingRoundTypes}
          ready={ready}
          onGenerated={(response) => {
            setLastGenerated(response);
            queryClient.invalidateQueries({ queryKey: ["matches", session.id] });
          }}
        />
      ) : event?.game_plugin_name && matchFormatError ? (
        <p className="alert alert-danger" role="alert">
          {t("errors.generic")}
        </p>
      ) : (
        <p className="field__hint">{t("sessions.schedule.form.needsGamePlugin")}</p>
      )}
    </div>
  );
}
