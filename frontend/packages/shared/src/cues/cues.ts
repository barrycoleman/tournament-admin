/** The in-match cue rules: from two consecutive readings of a timer, the
 * sounds to play and the flashes to show. Pure, so every TV and operator
 * computer decides the same thing. */

export type SoundSlot = "beep" | "start" | "buzzer" | "moment" | "stop";
export const SOUND_SLOTS: readonly SoundSlot[] = ["beep", "start", "buzzer", "moment", "stop"];

/** A named point in a match, from the game plugin's match format. With
 * `until_remaining` it is a window, firing when it opens and again when it closes. */
export interface Moment {
  key: string;
  label: string;
  period: "autonomous" | "driver";
  at_remaining: number;
  until_remaining: number | null;
}

export type FlashKind = "moment" | "over" | "stop";

/** One cue. A flash label of null means the screen's own text (MATCH OVER,
 * TIME, MATCH STOPPED, STOPPED). */
export interface Cue {
  sound: SoundSlot | null;
  flash: { kind: FlashKind; label: string | null } | null;
}

/** One reading of a match clock; `whole` is whole seconds left, rounded up. */
export interface MatchReading {
  matchId: number;
  phase: string;
  whole: number;
  paused: boolean;
  endedEarly: boolean;
}

/** One reading of a skills timer, keyed so a different timer reads as new. */
export interface SkillsReading {
  timerKey: string;
  phase: "ready" | "running" | "ended";
  whole: number;
  paused: boolean;
  endedEarly: boolean;
}

const BEEP: Cue = { sound: "beep", flash: null };
const START: Cue = { sound: "start", flash: null };
const OVER: Cue = { sound: "buzzer", flash: { kind: "over", label: null } };
const STOP: Cue = { sound: "stop", flash: { kind: "stop", label: null } };
const LAST_SECONDS = [3, 2, 1];

type Period = "autonomous" | "driver";

/** The phases of a match, in order; "live" is every phase strictly between
 * not started and ended. */
const MATCH_ORDER = ["not_started", "countdown_autonomous", "autonomous", "awaiting_driver", "countdown_driver", "driver"];
const LIVE_MATCH_PHASES = new Set(MATCH_ORDER.slice(1));
const COUNT_INS = new Set(["countdown_autonomous", "countdown_driver"]);
const SECTIONS = new Set(["autonomous", "driver"]);

/** The runout (buzzer, over) or an operator's early end (power-down, stop);
 * only the server's `ended_early` flag decides which. */
const ending = (endedEarly: boolean): Cue => (endedEarly ? STOP : OVER);

interface Threshold {
  at: number;
  cue: Cue;
}

/** Thresholds crossed going from `prev` to `next` inside one section, in
 * descending order, moments before a beep at the same second. `prevInSection`
 * false means `prev` had not reached the section yet (so every threshold at or
 * above `next` counts as crossed). */
function crossings(prevWhole: number, prevInSection: boolean, nextWhole: number, thresholds: Threshold[]): Cue[] {
  return thresholds
    .filter((th) => nextWhole <= th.at && (!prevInSection || prevWhole > th.at))
    .sort((a, b) => b.at - a.at)
    .map((th) => th.cue);
}

function sectionThresholds(moments: readonly Moment[], period: Period | null): Threshold[] {
  const out: Threshold[] = [];
  for (const m of moments) {
    if (m.period !== period) continue;
    const cue: Cue = { sound: "moment", flash: { kind: "moment", label: m.label } };
    out.push({ at: m.at_remaining, cue });
    if (m.until_remaining !== null) out.push({ at: m.until_remaining, cue });
  }
  // A stable sort keeps these after any moment at the same second.
  for (const at of LAST_SECONDS) out.push({ at, cue: BEEP });
  return out;
}

const NOT_STARTED = { phase: "not_started", whole: 0, paused: false, endedEarly: false };

/** The cues between two readings of a match clock. The first reading is
 * silent, so a TV turned on mid-match plays nothing. */
export function matchCues(prev: MatchReading | null, next: MatchReading | null, moments: readonly Moment[]): Cue[] {
  if (prev === null || next === null) return [];
  // A new match first seen already inside a section: its count-in and start
  // were missed, so this reading counts as a first reading.
  if (prev.matchId !== next.matchId && SECTIONS.has(next.phase)) return [];
  const before = prev.matchId === next.matchId ? prev : { ...NOT_STARTED, matchId: next.matchId };
  const wasLive = LIVE_MATCH_PHASES.has(before.phase);

  if (next.phase === "ended") {
    return wasLive ? [ending(next.endedEarly)] : [];
  }
  if (next.phase === "not_started") {
    return wasLive ? [STOP] : [];
  }
  // A section reset: driver control (or its count-in) back to waiting for it.
  if (next.phase === "awaiting_driver" && (before.phase === "driver" || before.phase === "countdown_driver")) {
    return [STOP];
  }
  if (next.paused) return [];

  const phaseChanged = before.phase !== next.phase;
  if (COUNT_INS.has(next.phase)) {
    return (phaseChanged || before.whole !== next.whole) && next.whole > 0 ? [BEEP] : [];
  }
  if (next.phase !== "autonomous" && next.phase !== "driver") return [];

  const cues: Cue[] = phaseChanged ? [START] : [];
  // A reading from outside this section (its count-in or an earlier phase)
  // counts as not yet in it.
  const prevInSection = before.phase === next.phase;
  cues.push(...crossings(before.whole, prevInSection, next.whole, sectionThresholds(moments, next.phase)));
  return cues;
}

/** The cues between two readings of a skills timer: no count-in, one section. */
export function skillsCues(prev: SkillsReading | null, next: SkillsReading | null): Cue[] {
  if (prev === null || next === null) return [];
  // A new timer first seen already running: its start was missed.
  if (prev.timerKey !== next.timerKey && next.phase === "running") return [];
  const before = prev.timerKey === next.timerKey ? prev : { ...next, phase: "ready" as const, whole: 0, paused: false };
  const wasLive = before.phase === "running";

  if (next.phase === "ended") return wasLive ? [ending(next.endedEarly)] : [];
  if (next.phase === "ready") return wasLive ? [STOP] : [];
  if (next.paused) return [];
  // Reset and started again between two reads: the TV never saw it ready.
  if (wasLive && next.whole > before.whole + MAX_JITTER_SECONDS) return [STOP, START];

  const cues: Cue[] = wasLive ? [] : [START];
  cues.push(...crossings(before.whole, wasLive, next.whole, sectionThresholds([], null)));
  return cues;
}

/** The reading to compare the next one against: the earlier, lower one when
 * the clock moves up within the same running phase of the same match (a
 * re-measured server-clock offset), so the next real second is not crossed
 * twice; otherwise the new reading. */
export function holdMatchReading(held: MatchReading | null, next: MatchReading | null): MatchReading | null {
  if (held === null || next === null) return next;
  const jitter =
    held.matchId === next.matchId &&
    held.phase === next.phase &&
    !held.paused &&
    !next.paused &&
    next.whole > held.whole;
  return jitter ? held : next;
}

/** The most a running skills timer's whole seconds may rise between reads
 * and still be clock jitter; a bigger rise is a reset and restart. */
const MAX_JITTER_SECONDS = 1;

/** The same rule for a running skills timer, for a rise of at most a second. */
export function holdSkillsReading(held: SkillsReading | null, next: SkillsReading | null): SkillsReading | null {
  if (held === null || next === null) return next;
  const jitter =
    held.timerKey === next.timerKey &&
    held.phase === "running" &&
    next.phase === "running" &&
    !held.paused &&
    !next.paused &&
    next.whole > held.whole &&
    next.whole <= held.whole + MAX_JITTER_SECONDS;
  return jitter ? held : next;
}

/** A time-out that runs out dings; a cancelled one (no deadline) is silent. */
export function timeoutCues(prevRemaining: number | null, nextRemaining: number | null): Cue[] {
  return prevRemaining !== null && prevRemaining > 0 && nextRemaining !== null && nextRemaining <= 0
    ? [{ sound: "moment", flash: null }]
    : [];
}

/** The window the clock is inside: in its period, until < remaining <= at. */
export function activeWindow(phase: string, remaining: number, moments: readonly Moment[]): Moment | null {
  return (
    moments.find(
      (m) =>
        m.until_remaining !== null && m.period === phase && remaining > m.until_remaining && remaining <= m.at_remaining
    ) ?? null
  );
}
