import { Link, useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { useDisplays } from "../displays/useDisplays";
import { useMakeActive } from "../orientation/MakeActiveDialog";
import {
  checkEventSetup,
  checkSessionReadiness,
  nextSessionStep,
  type SessionReadinessKey,
} from "../orientation/readiness";
import { useEvent, useSessions } from "../orientation/useOrientationData";
import { countCheckedInTeams } from "../schedule/readiness";
import { useSessionMatches } from "../useSessionMatches";
import type {
  Division,
  FieldRead,
  FieldSetRead,
  MatchFormat,
  ParticipationRead,
  SessionRead,
  TeamSummary,
} from "../types";

export function SessionTodayRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const makeActive = useMakeActive();

  const eventQuery = useEvent();
  const event = eventQuery.data;
  const sessionsQuery = useSessions();
  const sessions = sessionsQuery.data;
  const divisionsQuery = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const divisions = divisionsQuery.data;
  const teamsQuery = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const participantsQuery = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () =>
      apiRequest<ParticipationRead[]>(
        `/api/sessions/${session.id}/participants`,
      ),
  });
  const participants = participantsQuery.data;
  const teams = teamsQuery.data;
  const fieldSetsQuery = useQuery({
    queryKey: ["fieldSets", session.id],
    queryFn: () =>
      apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${session.id}`),
  });
  const fieldSets = fieldSetsQuery.data;
  const fieldsQuery = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () =>
      apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const fields = fieldsQuery.data;
  const windowsQuery = useQuery({
    queryKey: ["playingWindows", session.id],
    queryFn: () =>
      apiRequest<unknown[]>(`/api/sessions/${session.id}/playing-windows`),
  });
  const windows = windowsQuery.data;
  const matchFormatQuery = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<MatchFormat>("/api/event/match-format"),
    enabled: Boolean(event?.game_plugin_name),
  });
  const matchFormat = matchFormatQuery.data;
  const matchesQuery = useSessionMatches(session.id);
  const matches = matchesQuery.data;
  const displaysQuery = useDisplays(session.id);
  const displays = displaysQuery.data;
  const failed = [
    eventQuery,
    sessionsQuery,
    divisionsQuery,
    teamsQuery,
    participantsQuery,
    fieldSetsQuery,
    fieldsQuery,
    windowsQuery,
    matchFormatQuery,
    matchesQuery,
    displaysQuery,
  ].some((query) => query.isError);

  const loaded =
    event !== undefined &&
    sessions !== undefined &&
    divisions !== undefined &&
    teams !== undefined &&
    participants !== undefined &&
    fieldSets !== undefined &&
    fields !== undefined &&
    windows !== undefined &&
    matches !== undefined &&
    displays !== undefined &&
    (!event.game_plugin_name || matchFormat !== undefined);
  if (failed) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!loaded) return <p>{t("sessions.loading")}</p>;

  const eventSetup = checkEventSetup({
    gamePluginSelected: Boolean(event.game_plugin_name),
    teamCount: teams.length,
    sessionCount: sessions.length,
  }).filter((item) => !item.ok);
  const eventSetupLinks = {
    gamePlugin: "/events/setup",
    teams: "/teams",
    session: "/sessions/new",
  } as const;

  const items = checkSessionReadiness({
    session,
    activeSessionId: event.active_session_id,
    divisions,
    teams,
    participants,
    fieldSets,
    fields,
    windowCount: windows.length,
    matches,
    matchFormat: matchFormat ?? null,
    displayCount: displays.groups.reduce(
      (sum, group) => sum + group.displays.length,
      0,
    ),
  });
  const step = nextSessionStep(items);
  const teamsOk = items.find((item) => item.key === "teams")?.ok ?? false;
  const checkedIn = countCheckedInTeams(teams, participants, null);
  const base = `/sessions/${session.id}`;

  const rowLinks: Record<Exclude<SessionReadinessKey, "active">, string> = {
    timezone: `${base}/setup#session-timezone`,
    fields: `${base}/setup#fields`,
    playingTimes: `${base}/schedule#playing-times`,
    teams: `${base}/checkin`,
    schedule: `${base}/schedule`,
    displays: "/devices",
  };

  return (
    <div>
      {eventSetup.length > 0 && (
        <div className="alert alert-warning" role="alert">
          <p>{t("sessions.today.eventSetupHeading")}</p>
          <ul>
            {eventSetup.map((item) => (
              <li key={item.key}>
                {t(`sessions.today.eventSetup.${item.key}`)}{" "}
                <Link to={eventSetupLinks[item.key]}>
                  {t(`sessions.today.eventSetup.${item.key}Fix`)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="session-today">
        <section className="panel" aria-labelledby="today-checkin">
          <h2 id="today-checkin">{t("sessions.today.checkin.heading")}</h2>
          <p>
            {t("sessions.today.checkin.count", {
              checked: checkedIn,
              total: teams.length,
            })}
          </p>
          <progress
            max={teams.length}
            value={checkedIn}
            aria-label={t("sessions.today.checkin.heading")}
          />
          <p>
            <Link
              to={`${base}/checkin`}
              className={teamsOk ? "btn" : "btn btn-primary"}
            >
              {t("sessions.today.checkin.action")}
            </Link>
          </p>
        </section>
        <section className="panel" aria-labelledby="today-inspection">
          <h2 id="today-inspection">
            {t("sessions.today.inspection.heading")}
          </h2>
          <p className="field__hint">
            {t("sessions.today.inspection.placeholder")}
          </p>
        </section>
        <section className="panel" aria-labelledby="today-matches">
          <h2 id="today-matches">{t("sessions.today.matches.heading")}</h2>
          <ul className="today-checklist">
            {items.map((item) => (
              <li
                key={item.key}
                className={
                  item.ok ? "today-checklist__ok" : "today-checklist__todo"
                }
              >
                <span
                  role="img"
                  aria-label={
                    item.ok
                      ? t("sessions.today.matches.done")
                      : t("sessions.today.matches.notDone")
                  }
                >
                  {item.ok ? "✓" : "✗"}
                </span>{" "}
                {item.key === "active" ? (
                  item.ok ? (
                    t("sessions.today.matches.active")
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => makeActive.open(session)}
                    >
                      {t("sessions.today.matches.active")}
                    </button>
                  )
                ) : (
                  <Link to={rowLinks[item.key]}>
                    {t(`sessions.today.matches.${item.key}`)}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {step === "setup" && (
            <Link to={`${base}/setup`} className="btn btn-primary">
              {t("sessions.today.matches.setupAction")}
            </Link>
          )}
          {step === "planMatches" && (
            <Link to={`${base}/schedule`} className="btn btn-primary">
              {t("sessions.today.matches.planMatchesAction")}
            </Link>
          )}
          {step === "makeActive" && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => makeActive.open(session)}
            >
              {t("sessions.today.matches.makeActiveAction")}
            </button>
          )}
          {step === "matchControl" && (
            <Link to="/match-control" className="btn btn-primary">
              {t("sessions.today.matches.matchControlAction")}
            </Link>
          )}
        </section>
      </div>
      {makeActive.dialog}
    </div>
  );
}
