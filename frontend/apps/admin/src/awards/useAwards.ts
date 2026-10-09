import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { AwardSlotRead, SessionAwardsRead, TeamAwardHistory } from "../types";

export const awardsKey = (sessionId: number) => ["awards", sessionId];
export const teamHistoryKey = (sessionId: number) => ["awardTeamHistory", sessionId];

/** Live winners are computed on read, so anything that moves a result refetches. */
export const AWARD_REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "awards_changed",
  "score_saved",
  "ranking_updated",
  "skills_changed",
  "new_match_created",
]);

/** The path segment for a slot: its division id, or "event". */
export function slotKey(slot: Pick<AwardSlotRead, "division_id">): string {
  return slot.division_id === null ? "event" : String(slot.division_id);
}

export function useSessionAwards(sessionId: number) {
  return useQuery({
    queryKey: awardsKey(sessionId),
    queryFn: () => apiRequest<SessionAwardsRead>(`/api/sessions/${sessionId}/awards`),
  });
}

export function useTeamHistory(sessionId: number) {
  return useQuery({
    queryKey: teamHistoryKey(sessionId),
    queryFn: () => apiRequest<TeamAwardHistory[]>(`/api/sessions/${sessionId}/awards/team-history`),
  });
}
