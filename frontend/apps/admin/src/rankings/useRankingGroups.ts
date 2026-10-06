import { useQueries, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { Division, RankingRead } from "../types";

export type RankingScope = { kind: "session"; sessionId: number } | { kind: "season" };

export interface RankingGroup {
  divisionId: number | null;
  divisionName: string | null;
  rows: RankingRead[];
}

/** Invalidating this prefix refetches every division's rankings for the scope. */
export function rankingsKeyPrefix(scope: RankingScope): (string | number)[] {
  return scope.kind === "session" ? ["rankings", scope.sessionId] : ["rankings", "season"];
}

function rankingsPath(scope: RankingScope, divisionId: number | null): string {
  const params = new URLSearchParams();
  if (scope.kind === "session") params.set("session_id", String(scope.sessionId));
  else params.set("event_wide", "true");
  if (divisionId !== null) params.set("division_id", String(divisionId));
  return `/api/rankings?${params}`;
}

/**
 * Rankings for every division plus "no division": a single-division event's
 * scheduled matches carry no division, so those rows live under null even
 * when a division exists. Only groups with rows are returned.
 */
export function useRankingGroups(scope: RankingScope) {
  const divisionsQuery = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const divisions = divisionsQuery.data ?? [];
  const divisionIds: (number | null)[] = [null, ...divisions.map((division) => division.id)];
  const results = useQueries({
    queries: divisionsQuery.data
      ? divisionIds.map((divisionId) => ({
          queryKey: [...rankingsKeyPrefix(scope), divisionId],
          queryFn: () => apiRequest<RankingRead[]>(rankingsPath(scope, divisionId)),
        }))
      : [],
  });
  const nameById = new Map(divisions.map((division) => [division.id, division.name]));
  const groups: RankingGroup[] = results.flatMap((result, index) => {
    const rows = result.data ?? [];
    const divisionId = divisionIds[index];
    return rows.length > 0
      ? [{ divisionId, divisionName: divisionId === null ? null : (nameById.get(divisionId) ?? null), rows }]
      : [];
  });
  return {
    groups,
    isLoading: divisionsQuery.isLoading || results.some((result) => result.isLoading),
    isError: divisionsQuery.isError || results.some((result) => result.isError),
  };
}
