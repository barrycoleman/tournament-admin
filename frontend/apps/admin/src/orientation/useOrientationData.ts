import { useQueries, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { EventRead, PlayingWindowRead, SessionRead } from "../types";

export function useEvent() {
  return useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
}

export function useSessions() {
  return useQuery({ queryKey: ["sessions"], queryFn: () => apiRequest<SessionRead[]>("/api/sessions") });
}

/** Playing windows for several sessions at once, keyed by session id. */
export function useSessionWindows(sessionIds: number[]) {
  const results = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ["playingWindows", id],
      queryFn: () => apiRequest<PlayingWindowRead[]>(`/api/sessions/${id}/playing-windows`),
    })),
  });
  const windowsById: Record<number, PlayingWindowRead[]> = {};
  sessionIds.forEach((id, index) => {
    const data = results[index]?.data;
    if (data) windowsById[id] = data;
  });
  return { windowsById, isLoading: results.some((r) => r.isLoading) };
}

export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
