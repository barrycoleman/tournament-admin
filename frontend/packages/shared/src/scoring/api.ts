import { ApiError } from "../api-client";
import type { RealtimeEvent } from "../realtime";
import type { MatchClockAction, SkillsTimerAction, SubmitViolation } from "./types";

/** Every scoring endpoint the shared page calls. */
export const scoringPaths = {
  matchDraft: (matchId: number) => `/api/matches/${matchId}/draft`,
  allianceDraft: (matchId: number, allianceId: number) => `/api/matches/${matchId}/alliances/${allianceId}/draft`,
  submit: (matchId: number) => `/api/matches/${matchId}/submit`,
  matchAction: (matchId: number, action: MatchClockAction) => `/api/matches/${matchId}/${action}`,
  sessionScores: (sessionId: number) => `/api/scores?session_id=${sessionId}`,
  skillsSet: (fieldSetId: number) => `/api/field-sets/${fieldSetId}/skills`,
  setTimer: (fieldSetId: number, action: SkillsTimerAction) => `/api/field-sets/${fieldSetId}/skills-timer/${action}`,
  skillsRun: (fieldId: number) => `/api/fields/${fieldId}/skills-run`,
  skillsRunDraft: (fieldId: number) => `/api/fields/${fieldId}/skills-run/draft`,
  skillsRunAction: (fieldId: number, action: SkillsTimerAction) => `/api/fields/${fieldId}/skills-run/${action}`,
  skillsRunSubmit: (fieldId: number) => `/api/fields/${fieldId}/skills-run/submit`,
  skillsSchema: (skillsType: string) => `/api/skills/types/${skillsType}/schema`,
};

/** A request that never reached the server (fetch rejects with a TypeError, not an ApiError). */
export function isNetworkError(error: unknown): boolean {
  return !(error instanceof ApiError);
}

/** The `violations` list of a 422, whether the route put it at the top level or under `detail`. */
export function violationsOf(error: unknown): unknown[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const body = error.body as { violations?: unknown; detail?: { violations?: unknown } } | null;
  const list = body?.violations ?? body?.detail?.violations;
  return Array.isArray(list) ? list : null;
}

/** A refused Submit's problems, per alliance for a match or as one entry for a skills run. */
export function submitViolations(error: unknown): SubmitViolation[] | null {
  const list = violationsOf(error);
  if (list === null) return null;
  const result: SubmitViolation[] = [];
  const loose: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      loose.push(entry);
    } else if (entry && typeof entry === "object" && "messages" in entry) {
      const { alliance_id, messages } = entry as { alliance_id?: number; messages?: unknown };
      result.push({
        alliance_id: typeof alliance_id === "number" ? alliance_id : null,
        messages: Array.isArray(messages) ? messages.map(String) : [],
      });
    } else if (entry && typeof entry === "object" && "message" in entry) {
      const { field, message } = entry as { field?: unknown; message?: unknown };
      loose.push(typeof field === "string" ? `${field}: ${String(message)}` : String(message));
    }
  }
  if (loose.length > 0) result.push({ alliance_id: null, messages: loose });
  return result;
}

const MISSING_DRAFT = /^Alliance (\d+) has no draft score\.$/;

/** The alliance a Submit was refused for because nobody has scored it yet (409 "Alliance {id} has no draft score."), else null. */
export function missingDraftAlliance(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409 || typeof error.detail !== "string") return null;
  const match = MISSING_DRAFT.exec(error.detail);
  return match ? Number(match[1]) : null;
}

/** A readable message for a refused request: the server's text detail or its violations joined. */
export function errorText(error: unknown): string | null {
  const violations = submitViolations(error);
  if (violations) return violations.flatMap((entry) => entry.messages).join(" ");
  if (error instanceof ApiError && typeof error.detail === "string" && error.detail) return error.detail;
  return null;
}

/** A tiny fan-out so one socket's `onEvent` can feed several scoring hooks through `ScoringSocket.subscribe`. */
export function createScoringHub(): {
  emit: (event: RealtimeEvent) => void;
  subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
} {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
