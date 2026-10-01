import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { SessionRead } from "../types";

function tabLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function SessionDetailLayout() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();

  const { data: sessions, isLoading, isError } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const session = sessions?.find((candidate) => candidate.id === Number(sessionId));

  if (isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }
  if (isError) {
    // Distinct from "session not found" below: the list fetch itself
    // failed (network/server error), not "the id isn't in a
    // successfully-loaded list" -- show the generic error pattern used
    // elsewhere rather than the misleading "not found" message.
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
      </div>
      <nav className="app-nav app-nav--sub">
        <NavLink to={`/sessions/${session.id}/checkin`} className={tabLinkClassName}>
          {t("sessions.checkinTab")}
        </NavLink>
      </nav>
      <Outlet context={{ session }} />
    </div>
  );
}
