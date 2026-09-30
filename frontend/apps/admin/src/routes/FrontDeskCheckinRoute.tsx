import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
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

  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const sessionId = event?.active_session_id ?? null;

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
    if (!normalizedQuery) return teams ?? [];
    return (teams ?? []).filter(
      (team) =>
        team.number.toLowerCase().includes(normalizedQuery) ||
        team.name.toLowerCase().includes(normalizedQuery)
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
