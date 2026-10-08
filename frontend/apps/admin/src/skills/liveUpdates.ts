import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { skillsAttemptsKey } from "./useSessionSkills";
import { SKILLS_SETTINGS_KEY } from "./useSkillsSettings";

/**
 * Every skills event reaches /ws/active-session: skills_changed always goes
 * there, and so does every skills_settings_changed. So skills UI listens on
 * that one channel, whichever session it shows.
 */
export function handleSkillsEvent(queryClient: QueryClient, realtimeEvent: RealtimeEvent): void {
  if (realtimeEvent.event === "skills_changed") {
    const data = realtimeEvent.data as { session_id?: unknown } | null;
    if (typeof data?.session_id === "number") {
      queryClient.invalidateQueries({ queryKey: skillsAttemptsKey(data.session_id) });
    }
    queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
  } else if (realtimeEvent.event === "skills_settings_changed") {
    queryClient.invalidateQueries({ queryKey: SKILLS_SETTINGS_KEY });
    queryClient.invalidateQueries({ queryKey: ["sessionSkills"] });
    queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
  }
}

export function useSkillsLiveUpdates(): void {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => handleSkillsEvent(queryClient, realtimeEvent),
  });
}
