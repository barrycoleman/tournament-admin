import { useQuery } from "@tanstack/react-query";
import { apiRequest, type ScoresheetField } from "@tournament-admin/shared";
import type { SessionSkillsRead, SkillsAttemptRead } from "../types";

export const sessionSkillsKey = (sessionId: number) => ["sessionSkills", sessionId];
export const skillsAttemptsKey = (sessionId: number) => ["skillsAttempts", sessionId];
export const skillsSchemaKey = (typeKey: string) => ["skillsSchema", typeKey];

/** The session's skills types with their effective allowed attempts, and its override. */
export function useSessionSkills(sessionId: number) {
  return useQuery({
    queryKey: sessionSkillsKey(sessionId),
    queryFn: () => apiRequest<SessionSkillsRead>(`/api/sessions/${sessionId}/skills`),
  });
}

/** Every attempt recorded in the session. */
export function useSkillsAttempts(sessionId: number) {
  return useQuery({
    queryKey: skillsAttemptsKey(sessionId),
    queryFn: () => apiRequest<SkillsAttemptRead[]>(`/api/sessions/${sessionId}/skills/attempts`),
  });
}

/** One type's scoresheet fields. A plugin can't change once chosen, so this never goes stale. */
export function useSkillsSchema(typeKey: string | null) {
  return useQuery({
    queryKey: skillsSchemaKey(typeKey ?? ""),
    queryFn: () => apiRequest<ScoresheetField[]>(`/api/skills/types/${typeKey}/schema`),
    enabled: typeKey !== null,
    staleTime: Infinity,
  });
}
