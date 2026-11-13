import { useQueryClient } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";

/** Keeps the event and session list fresh when another admin changes the active session. */
export function useActiveSessionLiveUpdates(): void {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "active_session_changed") {
        void queryClient.invalidateQueries({ queryKey: ["event"] });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }
    },
  });
}
