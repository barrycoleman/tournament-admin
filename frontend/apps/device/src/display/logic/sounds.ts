import { COUNT_IN_PHASES, PERIOD_PHASES } from "@tournament-admin/shared";

export type Cue = "beat" | "start" | "warning" | "periodEnd" | "matchEnd" | "timeoutEnd";

/** One reading of the running match's clock, in whole seconds left. */
export interface ClockState {
  matchId: number;
  phase: string;
  whole: number;
  paused: boolean;
}

export const WARNING_SECONDS = 30;

/** The cues between two readings. The first reading is silent, so a display
 * turned on mid-match doesn't sound a start. */
export function matchCues(prev: ClockState | null, next: ClockState | null): Cue[] {
  if (prev === null || next === null || next.paused) return [];
  const before = prev.matchId === next.matchId ? prev : { ...next, phase: "not_started", whole: 0 };
  const cues: Cue[] = [];
  const phaseChanged = before.phase !== next.phase;
  if (COUNT_IN_PHASES.has(next.phase) && (phaseChanged || before.whole !== next.whole) && next.whole > 0) cues.push("beat");
  if (PERIOD_PHASES.has(next.phase) && phaseChanged) cues.push("start");
  if (PERIOD_PHASES.has(next.phase) && !phaseChanged && before.whole > WARNING_SECONDS && next.whole <= WARNING_SECONDS) {
    cues.push("warning");
  }
  if (PERIOD_PHASES.has(before.phase) && phaseChanged && next.phase !== "ended") cues.push("periodEnd");
  if (before.phase !== "ended" && next.phase === "ended") cues.push("matchEnd");
  return cues;
}

/** A time-out that runs out sounds; a cancelled one (no deadline) doesn't. */
export function timeoutCues(prevRemaining: number | null, nextRemaining: number | null): Cue[] {
  return prevRemaining !== null && prevRemaining > 0 && nextRemaining !== null && nextRemaining <= 0 ? ["timeoutEnd"] : [];
}
