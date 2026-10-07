import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import type { QualificationPreview } from "../types";

export const qualificationPreviewKey = (sessionId: number) => ["qualification-preview", sessionId];

const PREVIEW_EVENTS = new Set([
  "qualification_status_changed",
  "match_phase_changed",
  "match_reset",
  "score_saved",
  "new_match_created",
]);

/** The finalize preview, refreshed whenever a match or the qualification status changes. */
export function useQualificationPreview(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: `/ws/session/${sessionId}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (!PREVIEW_EVENTS.has(realtimeEvent.event)) return;
      queryClient.invalidateQueries({ queryKey: qualificationPreviewKey(sessionId) });
      if (realtimeEvent.event === "qualification_status_changed") {
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
      }
    },
  });
  return useQuery({
    queryKey: qualificationPreviewKey(sessionId),
    queryFn: () =>
      apiRequest<QualificationPreview>(`/api/sessions/${sessionId}/qualification/finalize-preview`),
  });
}
