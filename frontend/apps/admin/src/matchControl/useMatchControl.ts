import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiRequest,
  useRealtimeChannel,
  type AllianceScore,
  type LiveMatch,
  type ScreenSettings,
} from "@tournament-admin/shared";
import type { DisplaysRead, FieldRead, FieldSetLiveRead } from "../displays/types";
import type { TeamSummary } from "../types";

/** Which reads each live event makes stale on this page. */
const LIVE: Record<string, readonly string[]> = {
  match_phase_changed: ["matches"],
  match_paused: ["matches"],
  match_resumed: ["matches"],
  match_reset: ["matches"],
  new_match_created: ["matches"],
  score_saved: ["matches", "scores"],
  field_set_changed: ["fieldSets"],
  display_changed: ["displays"],
  active_session_changed: ["event"],
};

export function useMatchControlData(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      for (const key of LIVE[event.event] ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
  return {
    fieldSets: useQuery({
      queryKey: ["fieldSets", sessionId],
      queryFn: () => apiRequest<FieldSetLiveRead[]>(`/api/field-sets?session_id=${sessionId}`),
    }),
    fields: useQuery({
      queryKey: ["fields", sessionId],
      queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${sessionId}`),
    }),
    matches: useQuery({
      queryKey: ["matches", sessionId],
      queryFn: () => apiRequest<LiveMatch[]>(`/api/matches?session_id=${sessionId}`),
    }),
    scores: useQuery({
      queryKey: ["scores", sessionId],
      queryFn: () => apiRequest<AllianceScore[]>(`/api/scores?session_id=${sessionId}`),
    }),
    teams: useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") }),
    displays: useQuery({
      queryKey: ["displays", sessionId],
      queryFn: () => apiRequest<DisplaysRead>(`/api/displays?session_id=${sessionId}`),
    }),
  };
}

export type MatchAction = "start" | "start-driver" | "pause" | "resume" | "end" | "reset";

export function useMatchControlActions() {
  const queryClient = useQueryClient();
  const refresh = (...keys: string[]) =>
    Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  return {
    matchAction: useMutation({
      mutationFn: ({ matchId, action, body }: { matchId: number; action: MatchAction; body?: unknown }) =>
        apiRequest<LiveMatch>(`/api/matches/${matchId}/${action}`, body === undefined ? { method: "POST" } : { method: "POST", body }),
      onSuccess: () => refresh("matches", "displays", "fieldSets"),
    }),
    queue: useMutation({
      mutationFn: ({ fieldSetId, matchId }: { fieldSetId: number; matchId: number | null }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/queued-match`, { method: "PUT", body: { match_id: matchId } }),
      onSuccess: () => refresh("fieldSets"),
    }),
    startTimeout: useMutation({
      mutationFn: ({ fieldSetId, seconds }: { fieldSetId: number; seconds: number }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/timeout`, { method: "POST", body: { seconds } }),
      onSuccess: () => refresh("fieldSets"),
    }),
    cancelTimeout: useMutation({
      mutationFn: (fieldSetId: number) => apiRequest(`/api/field-sets/${fieldSetId}/timeout`, { method: "DELETE" }),
      onSuccess: () => refresh("fieldSets"),
    }),
    updateGroup: useMutation({
      mutationFn: ({
        groupId,
        ...body
      }: {
        groupId: number;
        screen?: string;
        screen_settings?: ScreenSettings;
        play_sounds?: boolean;
      }) => apiRequest(`/api/displays/groups/${groupId}`, { method: "PATCH", body }),
      onSuccess: () => refresh("displays"),
    }),
  };
}
