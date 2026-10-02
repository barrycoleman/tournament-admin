import { NavLink, Outlet, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { EventRead, SessionRead } from "../types";

function tabLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function SessionDetailLayout() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const queryClient = useQueryClient();

  const { data: sessions, isLoading, isError } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const activateMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest<EventRead>("/api/event/active-session", {
        method: "POST",
        body: { session_id: id },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event"] });
    },
  });
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
                onClick={() => activateMutation.mutate(session.id)}
                disabled={activateMutation.isPending}
              >
                {t("sessions.setActiveAction")}
              </button>
              <span className="field__hint">{t("sessions.setActiveHint")}</span>
            </div>
          ))}
        {activateMutation.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(activateMutation.error, t("errors.generic"))}
          </p>
        )}
      </div>
      <nav className="app-nav app-nav--sub">
        <NavLink to={`/sessions/${session.id}/checkin`} className={tabLinkClassName}>
          {t("sessions.checkinTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/fields`} className={tabLinkClassName}>
          {t("sessions.fieldsTab")}
        </NavLink>
        <NavLink to={`/sessions/${session.id}/matches`} className={tabLinkClassName}>
          {t("sessions.matchesTab")}
        </NavLink>
      </nav>
      <Outlet context={{ session }} />
    </div>
  );
}
