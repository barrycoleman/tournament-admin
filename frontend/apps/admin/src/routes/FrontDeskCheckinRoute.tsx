import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  apiRequest,
  ApiError,
  useRealtimeChannel,
  type RealtimeEvent,
} from "@tournament-admin/shared";
import type { EventRead } from "../types";

interface TeamApiRow {
  id: number;
  number: string;
  name: string;
}

interface ParticipationApiRow {
  team_id: number;
  checked_in: boolean;
}

export function FrontDeskCheckinRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  // isLoading/isError (not just `data`) matter here: the event query
  // being in flight or having failed both currently resolve to
  // `sessionId === null` below, same as a genuine "no active session" --
  // isLoading is checked explicitly further down so the empty state
  // doesn't flash on every page load/refresh before the real
  // active_session_id value resolves. A failed fetch still falls through
  // to that same empty state once settled (this screen has no separate
  // generic-error message today), which is an acceptable simplification:
  // either way there is nothing this kiosk can do until an admin sets an
  // active session or the transient error clears on its own retry.
  const { data: event, isLoading: isEventLoading } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const sessionId = event?.active_session_id ?? null;

  // An admin can change the active session (POST /api/event/active-session)
  // while this kiosk is sitting open on another device -- without this,
  // the kiosk would keep checking teams into the now-stale session with
  // no indication anything changed. The server broadcasts
  // active_session_changed on /ws/active-session whenever that happens;
  // refetching the ["event"] query on that event is enough, since every
  // query keyed off `sessionId` here already derives from its result.
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "active_session_changed") {
        queryClient.invalidateQueries({ queryKey: ["event"] });
      }
    },
  });

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamApiRow[]>("/api/teams"),
  });
  const { data: participants } = useQuery({
    queryKey: ["participants", sessionId],
    queryFn: () => apiRequest<ParticipationApiRow[]>(`/api/sessions/${sessionId}/participants`),
    enabled: sessionId !== null,
  });

  const checkedInByTeamId = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const participation of participants ?? []) {
      map.set(participation.team_id, participation.checked_in);
    }
    return map;
  }, [participants]);

  const visibleTeams = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matching = !normalizedQuery
      ? (teams ?? [])
      : (teams ?? []).filter(
          (team) =>
            team.number.toLowerCase().includes(normalizedQuery) ||
            team.name.toLowerCase().includes(normalizedQuery)
        );
    return [...matching].sort((a, b) =>
      a.number.localeCompare(b.number, undefined, { numeric: true })
    );
  }, [teams, query]);

  const checkInMutation = useMutation({
    mutationFn: (teamId: number) =>
      apiRequest(`/api/sessions/${sessionId}/participants`, {
        method: "POST",
        body: { team_id: teamId, checked_in: true },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["participants", sessionId] });
    },
  });

  if (isEventLoading) {
    return (
      <div className="front-desk-checkin">
        <p>{t("sessions.loading")}</p>
      </div>
    );
  }

  if (sessionId === null) {
    return (
      <div className="front-desk-checkin">
        <p className="alert alert-danger" role="alert">
          {t("frontDeskCheckin.noActiveSession")}
        </p>
      </div>
    );
  }

  return (
    <div className="front-desk-checkin">
      <h1>{t("frontDeskCheckin.heading")}</h1>
      <input
        className="input input--large"
        placeholder={t("frontDeskCheckin.searchPlaceholder")}
        aria-label={t("frontDeskCheckin.searchPlaceholder")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      {checkInMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {checkInMutation.error instanceof ApiError
            ? checkInMutation.error.detail
            : t("errors.generic")}
        </p>
      )}
      <ul className="front-desk-checkin__list">
        {visibleTeams.map((team) => {
          const checkedIn = checkedInByTeamId.get(team.id) ?? false;
          return (
            <li className="front-desk-checkin__row" key={team.id}>
              <span className="front-desk-checkin__team">
                {team.number} — {team.name}
              </span>
              <button
                type="button"
                className={checkedIn ? "btn btn-success btn-large" : "btn btn-primary btn-large"}
                disabled={checkedIn || checkInMutation.isPending}
                onClick={() => checkInMutation.mutate(team.id)}
              >
                {checkedIn ? t("frontDeskCheckin.checkedInState") : t("frontDeskCheckin.checkInAction")}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
