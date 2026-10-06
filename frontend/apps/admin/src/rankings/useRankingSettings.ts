import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { RankingSettingsRead } from "../types";

export const RANKING_SETTINGS_KEY = ["rankingSettings"];

/** The event's ranking settings, plus its game model (null before a game is chosen). */
export function useRankingSettings() {
  return useQuery({
    queryKey: RANKING_SETTINGS_KEY,
    queryFn: () => apiRequest<RankingSettingsRead>("/api/ranking-settings"),
  });
}
