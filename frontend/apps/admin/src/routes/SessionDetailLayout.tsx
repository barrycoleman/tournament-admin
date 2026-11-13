import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { useMakeActive } from "../orientation/MakeActiveDialog";
import { useSkillsLiveUpdates } from "../skills/liveUpdates";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { EventRead, SessionRead } from "../types";

function tabLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function SessionDetailLayout() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const makeActive = useMakeActive();

  const { data: sessions, isLoading, isError } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const skills = useSkillsSettings();
  // The one /ws/active-session subscription for every session tab (Skills, Rankings), so
  // the Skills tab itself appears and disappears live.
  useSkillsLiveUpdates();
  const session = sessions?.find((candidate) => candidate.id === Number(sessionId));

  if (isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }
  if (isError) {
    // Distinct from "session not found" below: the list fetch itself
    // failed (network/server error), not "the id isn't in a
    // successfully-loaded list".
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!session) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("sessions.notFound")}
      </p>
    );
  }

  return (
    <div>
      <div className="session-detail__header">
        <h1>{session.label}</h1>
        <p className="session-detail__meta">
          {session.session_date ?? t("sessions.noDateSet")}
          {" · "}
          {session.timezone ?? t("sessions.noTimezoneSet")}
        </p>
        {event &&
          (event.active_session_id === session.id ? (
            <span className="badge badge-success">{t("sessions.activeBadge")}</span>
          ) : (
            <div className="session-detail__activate">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => makeActive.open(session)}
              >
                {t("sessions.setActiveAction")}
              </button>
              <span className="field__hint">{t("sessions.setActiveHint")}</span>
            </div>
          ))}
      </div>
      <nav className="app-nav app-nav--sub">
        <NavLink to={`/sessions/${session.id}/today`} className={tabLinkClassName}>
          {t("sessions.todayTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/setup`} className={tabLinkClassName}>
          {t("sessions.setupTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/checkin`} className={tabLinkClassName}>
          {t("sessions.checkinTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/schedule`} className={tabLinkClassName}>
          {t("sessions.scheduleTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/matches`} className={tabLinkClassName}>
          {t("sessions.matchesTab")}
        </NavLink>
        {skills.data?.enabled && (
          <NavLink to={`/sessions/${session.id}/skills`} className={tabLinkClassName}>
            {t("sessions.skillsTab")}
          </NavLink>
        )}
        <NavLink to={`/sessions/${session.id}/rankings`} className={tabLinkClassName}>
          {t("sessions.rankingsTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/awards`} className={tabLinkClassName}>
          {t("sessions.awardsTab")}
        </NavLink>
      </nav>
      <Outlet context={{ session }} />
      {makeActive.dialog}
    </div>
  );
}
