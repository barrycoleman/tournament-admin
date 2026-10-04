import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DivisionPlanner } from "../schedule/DivisionPlanner";
import { DivisionTabs } from "../schedule/DivisionTabs";
import { OutOfScopeRounds } from "../schedule/OutOfScopeRounds";
import { ReadinessChecklist } from "../schedule/ReadinessChecklist";
import { checkReadiness, countCheckedInTeams, countUsableFields } from "../schedule/readiness";
import { summarizeOutOfScopeRounds } from "../schedule/roundSummary";
import { useSessionMatches } from "../useSessionMatches";
import type {
  Division,
  EventRead,
  FieldRead,
  FieldSetRead,
  MatchFormat,
  ParticipationRead,
  PlayingWindowRead,
  SessionRead,
  TeamSummary,
} from "../types";

export function SessionScheduleRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [selectedDivisionId, setSelectedDivisionId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingDivisionId, setPendingDivisionId] = useState<number | null>(null);

  const { data: divisions, isError: divisionsError } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: event } = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const { data: matchFormat, isError: matchFormatError } = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<MatchFormat>("/api/event/match-format"),
    enabled: Boolean(event?.game_plugin_name),
  });
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
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
  const { data: windows } = useQuery({
    queryKey: ["playingWindows", session.id],
    queryFn: () => apiRequest<PlayingWindowRead[]>(`/api/sessions/${session.id}/playing-windows`),
  });
  const { data: matches, dataUpdatedAt: matchesUpdatedAt } = useSessionMatches(session.id);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

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
  const multiDivision = divisions.length > 1;
  const divisionId = multiDivision ? (selectedDivisionId ?? divisions[0].id) : null;

  const readiness = checkReadiness({
    gamePluginSelected: Boolean(event?.game_plugin_name),
    sessionTimezone: session.timezone,
    playingWindowCount: windows?.length ?? 0,
    checkedInTeamCount: countCheckedInTeams(teams ?? [], participants ?? [], divisionId),
    teamsNeeded: matchFormat ? matchFormat.teams_per_alliance * matchFormat.alliance_count : 0,
    usableFieldCount: countUsableFields(fieldSets ?? [], fields ?? [], divisionId),
  });
  const ready = readiness.every((item) => item.ok);
  // Listing blockers before their data arrives would flash false warnings.
  const readinessLoaded =
    event !== undefined &&
    teams !== undefined &&
    participants !== undefined &&
    fieldSets !== undefined &&
    fields !== undefined &&
    windows !== undefined &&
    (!event.game_plugin_name || matchFormat !== undefined);
  const outOfScopeRounds = summarizeOutOfScopeRounds(matches ?? [], multiDivision);

  function selectDivision(id: number) {
    if (id === divisionId) return;
    if (dirty) setPendingDivisionId(id);
    else setSelectedDivisionId(id);
  }

  const planner =
    matchFormat && windows ? (
      <DivisionPlanner
        key={divisionId ?? "none"}
        session={session}
        divisionId={divisionId}
        matchFormat={matchFormat}
        windows={windows}
        ready={ready}
        matchesUpdatedAt={matchesUpdatedAt}
        onDirtyChange={onDirtyChange}
      />
    ) : event?.game_plugin_name && matchFormatError ? (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    ) : event && !event.game_plugin_name ? (
      <p className="field__hint">{t("sessions.schedule.needsGamePlugin")}</p>
    ) : null;

  return (
    <div className="session-schedule">
      {readinessLoaded && <ReadinessChecklist items={readiness} sessionId={session.id} />}
      {multiDivision && (
        <DivisionTabs
          divisions={divisions}
          counts={new Map(divisions.map((d) => [d.id, countCheckedInTeams(teams ?? [], participants ?? [], d.id)]))}
          selectedId={divisionId!}
          onSelect={selectDivision}
        />
      )}
      <OutOfScopeRounds sessionId={session.id} divisions={divisions} rounds={outOfScopeRounds} />
      {multiDivision ? (
        <div role="tabpanel" id="division-panel" aria-labelledby={`division-tab-${divisionId}`}>
          {planner}
        </div>
      ) : (
        planner
      )}
      {pendingDivisionId !== null && (
        <ConfirmDialog
          heading={t("sessions.schedule.discardHeading")}
          body={t("sessions.schedule.discardBody")}
          confirmLabel={t("sessions.schedule.discardConfirm")}
          cancelLabel={t("sessions.schedule.keepEditing")}
          onConfirm={() => {
            setSelectedDivisionId(pendingDivisionId);
            setPendingDivisionId(null);
            setDirty(false);
          }}
          onCancel={() => setPendingDivisionId(null)}
        />
      )}
    </div>
  );
}
