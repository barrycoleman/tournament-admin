import { useMemo } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  LiveScoringPage,
  apiRequest,
  createScoringHub,
  useRealtimeChannel,
  type AllianceScore,
  type LiveMatch,
  type RealtimeEvent,
  type ScoresheetField,
  type ScoringAlliance,
  type ScoringMatchFormat,
} from "@tournament-admin/shared";
import { SubmittedScores } from "../matchScoring/SubmittedScores";
import { useScoresheetT } from "../skills/useScoresheetT";
import type { SessionRead, TeamSummary } from "../types";

/** The name the server records for an admin's draft changes. */
const ADMIN_DEVICE_NAME = "Admin";

/** Events that move this match's clock or scores. */
const MATCH_EVENTS = new Set([
  "match_phase_changed",
  "match_paused",
  "match_resumed",
  "match_reset",
  "match_submitted",
  "score_saved",
]);

/** /sessions/:sessionId/matches/:matchId/score: live scoring for an unsubmitted match, else its scores with "Correct score". */
export function MatchScoringRoute() {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const matchId = Number(useParams().matchId);
  const queryClient = useQueryClient();
  const hub = useMemo(createScoringHub, []);
  const { connected } = useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event: RealtimeEvent) => {
      hub.emit(event);
      const data = event.data as { match_id?: number } | null;
      if (!MATCH_EVENTS.has(event.event) || data?.match_id !== matchId) return;
      void queryClient.invalidateQueries({ queryKey: ["match", matchId] });
      if (event.event === "match_submitted" || event.event === "score_saved") {
        void queryClient.invalidateQueries({ queryKey: ["scores", session.id] });
      }
    },
  });
  const socketEvents = useMemo(() => ({ connected, subscribe: hub.subscribe }), [connected, hub]);

  const match = useQuery({
    queryKey: ["match", matchId],
    queryFn: () => apiRequest<LiveMatch>(`/api/matches/${matchId}`),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
  const schema = useQuery({
    queryKey: ["scoresheetSchema"],
    queryFn: () => apiRequest<ScoresheetField[]>("/api/event/scoresheet-schema"),
  });
  const matchFormat = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<ScoringMatchFormat>("/api/event/match-format"),
  });
  const scores = useQuery({
    queryKey: ["scores", session.id],
    queryFn: () => apiRequest<AllianceScore[]>(`/api/scores?session_id=${session.id}`),
  });

  const back = (
    <p>
      <Link to={`/sessions/${session.id}/matches`}>{t("matchScoring.back")}</Link>
    </p>
  );

  if (match.error instanceof ApiError && match.error.status === 404) {
    return (
      <div>
        {back}
        <p className="alert alert-warning" role="status">
          {t("scoring.gone")}
        </p>
      </div>
    );
  }
  if (!match.data || !teams.data || !schema.data || !matchFormat.data || !scores.data) {
    return (
      <div>
        {back}
        <p>{t("matchScoring.loading")}</p>
      </div>
    );
  }

  const teamById = new Map(teams.data.map((team) => [team.id, team]));
  const matchScores = scores.data.filter((row) => row.match_id === matchId);
  const submitted =
    match.data.alliances.length > 0 &&
    match.data.alliances.every((alliance) => matchScores.some((row) => row.alliance_id === alliance.id));
  const alliances: ScoringAlliance[] = match.data.alliances.map((alliance) => ({
    alliance_id: alliance.id,
    station: alliance.station,
    teams: alliance.team_ids.map((id) => ({
      id,
      number: teamById.get(id)?.number ?? String(id),
      name: teamById.get(id)?.name ?? "",
    })),
  }));

  return (
    <div className="match-scoring">
      {back}
      <h2>{t("matchScoring.heading", { match: match.data.label })}</h2>
      {submitted ? (
        <SubmittedScores
          match={match.data}
          scores={matchScores}
          schema={schema.data}
          matchFormat={matchFormat.data}
          teams={teamById}
        />
      ) : (
        <LiveScoringPage
          key={matchId}
          matchId={matchId}
          sessionId={session.id}
          t={scoresheetT}
          myDeviceName={ADMIN_DEVICE_NAME}
          match={match.data}
          alliances={alliances}
          schema={schema.data}
          matchFormat={matchFormat.data}
          socketEvents={socketEvents}
          request={apiRequest}
          onClockChanged={() => void queryClient.invalidateQueries({ queryKey: ["match", matchId] })}
        />
      )}
    </div>
  );
}
