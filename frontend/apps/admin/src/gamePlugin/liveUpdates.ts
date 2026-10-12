import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RANKING_SETTINGS_KEY } from "../rankings/useRankingSettings";
import { SKILLS_SETTINGS_KEY } from "../skills/useSkillsSettings";

/** game_plugin_changed reaches every socket; on it, refetch everything the plugin shapes. */
export function handleGamePluginEvent(queryClient: QueryClient, realtimeEvent: RealtimeEvent): void {
  if (realtimeEvent.event !== "game_plugin_changed") return;
  for (const queryKey of [
    ["event"],
    SKILLS_SETTINGS_KEY,
    RANKING_SETTINGS_KEY,
    ["matchFormat"],
    ["awards"],
    ["rankings"],
    ["skillsRankings"],
    ["sessionSkills"],
  ]) {
    queryClient.invalidateQueries({ queryKey });
  }
}

export function useGamePluginLiveUpdates(): void {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => handleGamePluginEvent(queryClient, realtimeEvent),
  });
}
