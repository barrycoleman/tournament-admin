import {
  READ_MS,
  useMatchReadingFrom,
  useServerNow,
  useSkillsReading as useSharedSkillsReading,
  useTimerCues,
  type Cue,
  type MatchReading,
  type SkillsClockState,
  type SkillsReading,
} from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useOptionalSkillsSet } from "./api";
import { fieldIdsOf } from "./screens/inMatch";

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

/** The match clock on these fields (the running match, else the last
 * ended one); null when there is none or no fields. */
export function useMatchReading(sessionId: number, fieldIds: readonly number[]): MatchReading | null {
  return useMatchReadingFrom(useMatches(sessionId).data, fieldIds);
}

export type SkillsTimerLike = SkillsClockState;

/** A skills timer's reading; `timerKey` names the timer, so another one
 * reads as new. */
export function useSkillsReading(timer: SkillsTimerLike | null, timerKey: string): SkillsReading | null {
  return useSharedSkillsReading(timer, timerKey);
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
  useTimerCues({ key: followsKey(follows), match, skills, timeout, moments }, onCues);
}
