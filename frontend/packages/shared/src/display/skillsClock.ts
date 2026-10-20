/** A skills timer as the server sends it: a skills field set's timer or one run's own. */
export interface SkillsClockState {
  phase: string;
  deadline: string | null;
  paused: boolean;
  remaining_seconds: number | null;
}

export type SkillsClockAction = "start" | "pause" | "resume" | "reset" | "end";

/** "ready", "running" or "ended". A running timer past its deadline reads as
 * ended between reads, the way the server reads it. */
export function skillsClockPhase(timer: SkillsClockState, nowMs: number): string {
  if (timer.phase === "running" && !timer.paused && timer.deadline !== null && Date.parse(timer.deadline) <= nowMs) {
    return "ended";
  }
  return timer.phase;
}

/** Seconds left: to the deadline while running, frozen while paused, and the
 * run's full length (`fullSeconds`) while ready unless the server sent one. */
export function skillsClockSeconds(timer: SkillsClockState, nowMs: number, fullSeconds: number | null): number {
  const phase = skillsClockPhase(timer, nowMs);
  if (phase === "ended") return 0;
  if (phase === "running" && !timer.paused && timer.deadline !== null) {
    return Math.max(0, (Date.parse(timer.deadline) - nowMs) / 1000);
  }
  return timer.remaining_seconds ?? fullSeconds ?? 0;
}

/** The controls a timer offers right now. */
export function skillsClockActions(timer: SkillsClockState, nowMs: number): SkillsClockAction[] {
  const phase = skillsClockPhase(timer, nowMs);
  if (phase === "ready") return ["start"];
  if (phase === "ended") return ["reset"];
  return [timer.paused ? "resume" : "pause", "end", "reset"];
}
