import { useCallback } from "react";
import {
  holdMatchReading,
  holdSkillsReading,
  latestStartedMatchForFieldSet,
  matchCues,
  remainingSeconds,
  skillsClockPhase,
  skillsClockSeconds,
  skillsCues,
  timeoutCues,
  useCueTrigger,
  useHeldReading,
  useServerNow,
  type Cue,
  type MatchReading,
  type SkillsClockState,
  type SkillsReading,
} from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useOptionalSkillsSet } from "./api";
import { fieldIdsOf } from "./screens/inMatch";

/** How often a TV reads its timer, so a cue lands within 0.1 s of the
 * server-time crossing. */
const READ_MS = 100;

/** The timer a TV follows for its cues. */
export type Follows =
  | { kind: "fieldSet"; fieldSetId: number; timeoutDeadline: string | null }
  | { kind: "field"; fieldId: number; timeoutDeadline: string | null }
  | { kind: "skillsSet"; fieldSetId: number }
  | { kind: "skillsField"; fieldSetId: number; fieldId: number };

/** Which timer, ignoring the time-out deadline: a change here starts over
 * from a first reading. */
export function followsKey(follows: Follows): string {
  switch (follows.kind) {
    case "fieldSet":
      return `fieldSet:${follows.fieldSetId}`;
    case "field":
      return `field:${follows.fieldId}`;
    case "skillsSet":
      return `skillsSet:${follows.fieldSetId}`;
    case "skillsField":
      return `skillsField:${follows.fieldSetId}:${follows.fieldId}`;
  }
}

const wholeSeconds = (seconds: number) => Math.ceil(seconds - 1e-9);

/** The match clock on these fields (the running match, else the last
 * ended one); null when there is none or no fields. */
export function useMatchReading(sessionId: number, fieldIds: readonly number[]): MatchReading | null {
  const now = useServerNow(READ_MS);
  const matches = useMatches(sessionId);
  const match =
    matches.data && fieldIds.length > 0 ? latestStartedMatchForFieldSet(matches.data, fieldIds) : null;
  const reading: MatchReading | null = match
    ? {
        matchId: match.id,
        phase: match.phase,
        whole: wholeSeconds(remainingSeconds(match, now) ?? 0),
        paused: match.paused,
        endedEarly: match.ended_early,
      }
    : null;
  return useHeldReading(reading, holdMatchReading);
}

export type SkillsTimerLike = SkillsClockState;

/** A skills timer's reading; `timerKey` names the timer, so another one
 * reads as new. */
export function useSkillsReading(timer: SkillsTimerLike | null, timerKey: string): SkillsReading | null {
  const now = useServerNow(READ_MS);
  const reading: SkillsReading | null = timer
    ? {
        timerKey,
        phase: skillsClockPhase(timer, now) as SkillsReading["phase"],
        whole: wholeSeconds(skillsClockSeconds(timer, now, null)),
        paused: timer.paused,
        endedEarly: timer.ended_early,
      }
    : null;
  return useHeldReading(reading, holdSkillsReading);
}

interface FollowedReading {
  key: string;
  match: MatchReading | null;
  skills: SkillsReading | null;
  timeout: number | null;
}

/** Calls `onCues` with the cues of the timer a TV follows: its field set's
 * match clock, its field's match (each with the field set's time-out), or a
 * skills timer. */
export function useFollowedCues(sessionId: number, follows: Follows, onCues: (cues: Cue[]) => void): void {
  const now = useServerNow(READ_MS);
  const fields = useFields(sessionId);
  const moments = useMatchFormat().data?.moments;
  let fieldIds: readonly number[] = [];
  if (follows.kind === "fieldSet" && fields.data) fieldIds = fieldIdsOf(fields.data, follows.fieldSetId);
  if (follows.kind === "field") fieldIds = [follows.fieldId];
  const match = useMatchReading(sessionId, fieldIds);

  const skillsSetId = follows.kind === "skillsSet" || follows.kind === "skillsField" ? follows.fieldSetId : null;
  const set = useOptionalSkillsSet(skillsSetId).data;
  let timer: SkillsTimerLike | null = null;
  let timerKey = "";
  if (follows.kind === "skillsSet" && set) {
    timer = set.timer;
    timerKey = `set:${follows.fieldSetId}`;
  } else if (follows.kind === "skillsField" && set) {
    const run = set.fields.find((field) => field.field_id === follows.fieldId)?.run ?? null;
    timer = run;
    timerKey = run ? `run:${run.id}` : "";
  }
  const skills = useSkillsReading(timer, timerKey);

  const deadline = follows.kind === "fieldSet" || follows.kind === "field" ? follows.timeoutDeadline : null;
  const timeout = deadline === null ? null : (Date.parse(deadline) - now) / 1000;
  const reading: FollowedReading = { key: followsKey(follows), match, skills, timeout };

  const compute = useCallback(
    (prev: FollowedReading | null, next: FollowedReading | null): Cue[] => {
      // Following another timer starts over, like a TV just switched on.
      if (prev === null || next === null || prev.key !== next.key) return [];
      return [
        ...matchCues(prev.match, next.match, moments ?? []),
        ...skillsCues(prev.skills, next.skills),
        ...timeoutCues(prev.timeout, next.timeout),
      ];
    },
    [moments]
  );
  useCueTrigger(reading, compute, onCues);
}
