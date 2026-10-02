import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import type { MatchRead } from "./types";

/**
 * The session's matches, kept live off the admin-only session channel.
 * DELETE /api/schedule broadcasts nothing, so a client that clears a round
 * must invalidate ["matches", sessionId] itself.
 */
export function useSessionMatches(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: `/ws/session/${sessionId}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "new_match_created" || realtimeEvent.event === "score_saved") {
        queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
      }
    },
  });
  return useQuery({
    queryKey: ["matches", sessionId],
    queryFn: () => apiRequest<MatchRead[]>(`/api/matches?session_id=${sessionId}`),
  });
}
