import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiRequest,
  createScoringHub,
  useRealtimeChannel,
  type ScoringSocket,
  type SkillsClockAction,
  type SkillsSet,
} from "@tournament-admin/shared";
import { handleSkillsEvent } from "../skills/liveUpdates";
import { useSessionSkills, useSkillsAttempts } from "../skills/useSessionSkills";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { FieldSetRead, TeamSummary } from "../types";

export const skillsSetKey = (fieldSetId: number) => ["skillsSet", fieldSetId];

/** The local time, re-read every `intervalMs` so countdowns move. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Everything Skills Control shows for the active session, kept live off /ws/active-session. */
export function useSkillsControlData(sessionId: number) {
  const queryClient = useQueryClient();
  // The same socket feeds the scoring panel (Task 13's SkillsRunPanel) through a hub.
  const hub = useMemo(createScoringHub, []);
  const channel = useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      hub.emit(event);
      if (event.event === "skills_run_changed") {
        const fieldSetId = (event.data as { field_set_id?: unknown } | null)?.field_set_id;
        void queryClient.invalidateQueries({
          queryKey: typeof fieldSetId === "number" ? skillsSetKey(fieldSetId) : ["skillsSet"],
        });
      } else if (event.event === "active_session_changed") {
        void queryClient.invalidateQueries({ queryKey: ["event"] });
      } else {
        handleSkillsEvent(queryClient, event);
      }
    },
  });
  const fieldSets = useQuery({
    queryKey: ["fieldSets", sessionId],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${sessionId}`),
  });
  const skillsSets = (fieldSets.data ?? []).filter((fieldSet) => fieldSet.purpose === "skills");
  const sets = useQueries({
    queries: skillsSets.map((fieldSet) => ({
      queryKey: skillsSetKey(fieldSet.id),
      queryFn: () => apiRequest<SkillsSet>(`/api/field-sets/${fieldSet.id}/skills`),
    })),
  });
  const socketEvents: ScoringSocket = useMemo(
    () => ({ connected: channel?.connected ?? false, subscribe: hub.subscribe }),
    [channel?.connected, hub]
  );
  return {
    fieldSets,
    skillsSets,
    sets,
    socketEvents,
    settings: useSkillsSettings(),
    sessionSkills: useSessionSkills(sessionId),
    attempts: useSkillsAttempts(sessionId),
    teams: useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") }),
  };
}

export function useSkillsControlActions() {
  const queryClient = useQueryClient();
  const refresh = (fieldSetId: number) => queryClient.invalidateQueries({ queryKey: skillsSetKey(fieldSetId) });
  return {
    setTimer: useMutation({
      mutationFn: ({ fieldSetId, action }: { fieldSetId: number; action: SkillsClockAction }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/skills-timer/${action}`, { method: "POST" }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
    setType: useMutation({
      mutationFn: ({ fieldSetId, skillsType }: { fieldSetId: number; skillsType: string }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/skills-timer`, { method: "PUT", body: { skills_type: skillsType } }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
    fieldTimer: useMutation({
      mutationFn: ({ fieldId, action }: { fieldSetId: number; fieldId: number; action: SkillsClockAction }) =>
        apiRequest(`/api/fields/${fieldId}/skills-run/${action}`, { method: "POST" }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
    discard: useMutation({
      mutationFn: ({ fieldId }: { fieldSetId: number; fieldId: number }) =>
        apiRequest<void>(`/api/fields/${fieldId}/skills-run`, { method: "DELETE" }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
  };
}
