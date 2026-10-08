import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { SkillsRankingRead } from "../types";

export type SkillsScope = { kind: "session"; sessionId: number } | { kind: "season" };

export function skillsRankingsKey(scope: SkillsScope, tab: string): (string | number)[] {
  return ["skillsRankings", scope.kind === "session" ? scope.sessionId : "season", tab];
}

export function skillsRankingsPath(scope: SkillsScope, tab: string): string {
  const params = new URLSearchParams({ tab });
  if (scope.kind === "session") params.set("session_id", String(scope.sessionId));
  else params.set("season", "true");
  return `/api/skills/rankings?${params}`;
}

export function useSkillsRankings(scope: SkillsScope, tab: string) {
  return useQuery({
    queryKey: skillsRankingsKey(scope, tab),
    queryFn: () => apiRequest<SkillsRankingRead[]>(skillsRankingsPath(scope, tab)),
  });
}
