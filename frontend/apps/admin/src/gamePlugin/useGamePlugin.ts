import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export const GAME_PLUGIN_SECTION_PATH = "/events/setup#game-plugins";

/** Whether the event has a game plugin; every gated screen asks this one hook. */
export function useGamePlugin() {
  const { data, isLoading } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  return {
    selected: Boolean(data?.game_plugin_name),
    locked: data?.game_plugin_locked ?? false,
    name: data?.game_plugin_name ?? null,
    isLoading,
  };
}
