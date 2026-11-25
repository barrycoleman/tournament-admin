import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import type {
  AllianceSelection,
  FieldRead,
  FieldSetRead,
  FinalsBracket,
  FinalsExclusion,
  FinalsExclusionReason,
  MatchFormat,
  TeamSummary,
} from "../types";

/** Finals belong to a session and a division; null is "no division" (a single-division event). */
export interface FinalsScope {
  sessionId: number;
  divisionId: number | null;
}

function scopeQuery({ sessionId, divisionId }: FinalsScope): string {
  const params = new URLSearchParams({ session_id: String(sessionId) });
  if (divisionId !== null) params.set("division_id", String(divisionId));
  return params.toString();
}

export function finalsKey(scope: FinalsScope): (string | number | null)[] {
  return ["finals", scope.sessionId, scope.divisionId];
}

export function finalsExclusionsKey(scope: FinalsScope): (string | number | null)[] {
  return ["finalsExclusions", scope.sessionId, scope.divisionId];
}

/** Every finals and exclusion write broadcasts `finals_changed` on the session channel. */
export function useFinalsLiveUpdates(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: `/ws/session/${sessionId}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "finals_changed") {
        queryClient.invalidateQueries({ queryKey: ["finals", sessionId] });
        queryClient.invalidateQueries({ queryKey: ["finalsExclusions", sessionId] });
      } else if (realtimeEvent.event === "ranking_updated") {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix({ kind: "session", sessionId }) });
      }
    },
  });
}

export function useFinalsBrackets(scope: FinalsScope) {
  return useQuery({
    queryKey: finalsKey(scope),
    queryFn: () => apiRequest<FinalsBracket[]>(`/api/finals?${scopeQuery(scope)}`),
  });
}

export function useFinalsExclusions(scope: FinalsScope) {
  return useQuery({
    queryKey: finalsExclusionsKey(scope),
    queryFn: () => apiRequest<FinalsExclusion[]>(`/api/finals/exclusions?${scopeQuery(scope)}`),
  });
}

export function useMatchFormat() {
  return useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<MatchFormat>("/api/event/match-format"),
  });
}

export function useTeams() {
  return useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
}

/** Teams, field sets and fields the set-up page reads; shared keys with the other session tabs. */
export function useFinalsSetupData(sessionId: number) {
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
  const fieldSets = useQuery({
    queryKey: ["fieldSets", sessionId],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${sessionId}`),
  });
  const fields = useQuery({
    queryKey: ["fields", sessionId],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${sessionId}`),
  });
  return { teams, fieldSets, fields };
}

export function useExclusionMutations(scope: FinalsScope) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: finalsExclusionsKey(scope) });
  const exclude = useMutation({
    mutationFn: ({ teamId, reason }: { teamId: number; reason: FinalsExclusionReason }) =>
      apiRequest<FinalsExclusion>("/api/finals/exclusions", {
        method: "POST",
        body: { session_id: scope.sessionId, division_id: scope.divisionId, team_id: teamId, reason },
      }),
    onSettled: refresh,
  });
  const undo = useMutation({
    mutationFn: (exclusionId: number) =>
      apiRequest<void>(`/api/finals/exclusions/${exclusionId}`, { method: "DELETE" }),
    onSettled: refresh,
  });
  return { exclude, undo };
}

export interface StartFinalsBody {
  session_id: number;
  division_id: number | null;
  team_count: number;
  alliance_selection: AllianceSelection;
  field_ids: number[];
  field_set_id?: number;
  wins_to_advance?: number[];
}

export function useStartFinals(scope: FinalsScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StartFinalsBody) =>
      apiRequest<FinalsBracket>("/api/finals/start", { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: finalsKey(scope) });
      queryClient.invalidateQueries({ queryKey: ["matches", scope.sessionId] });
    },
  });
}

/** The partner-picking steps; each returns the updated bracket and broadcasts `finals_changed`. */
export function useSelectionMutations(scope: FinalsScope, bracketId: number) {
  const queryClient = useQueryClient();
  const base = `/api/finals/${bracketId}/selection`;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: finalsKey(scope) });
    queryClient.invalidateQueries({ queryKey: ["matches", scope.sessionId] });
  };
  const withTeam = (step: string) => ({
    mutationFn: (teamId: number) =>
      apiRequest<FinalsBracket>(`${base}/${step}`, { method: "POST", body: { team_id: teamId } }),
    onSettled: refresh,
  });
  const noBody = (step: string) => ({
    mutationFn: () => apiRequest<FinalsBracket>(`${base}/${step}`, { method: "POST" }),
    onSettled: refresh,
  });
  return {
    invite: useMutation(withTeam("invite")),
    accept: useMutation(withTeam("accept")),
    decline: useMutation(withTeam("decline")),
    cancel: useMutation(noBody("cancel")),
    undo: useMutation(noBody("undo")),
    finish: useMutation(noBody("finish")),
  };
}

/** Start over: removes the finals (and their matches) so set-up shows again. */
export function useDeleteFinals(scope: FinalsScope, bracketId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>(`/api/finals/${bracketId}`, { method: "DELETE" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: finalsKey(scope) });
      queryClient.invalidateQueries({ queryKey: ["matches", scope.sessionId] });
    },
  });
}

/** "Can't play": the whole alliance forfeits its remaining games. */
export function useMarkUnavailable(scope: FinalsScope, bracketId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (allianceId: number) =>
      apiRequest<FinalsBracket>(`/api/finals/${bracketId}/alliances/${allianceId}/unavailable`, {
        method: "POST",
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: finalsKey(scope) });
      queryClient.invalidateQueries({ queryKey: ["matches", scope.sessionId] });
    },
  });
}
