import { useCallback, useEffect, useRef } from "react";
import { remainingSeconds } from "../display/clock";
import { latestStartedMatchForFieldSet } from "../display/matchOrder";
import { skillsClockPhase, skillsClockSeconds, type SkillsClockState } from "../display/skillsClock";
import type { LiveMatch } from "../display/types";
import { holdMatchReading, holdSkillsReading, matchCues, skillsCues, timeoutCues, type Cue, type MatchReading, type Moment, type SkillsReading } from "./cues";
import { useCueTrigger, useHeldReading } from "./useCueTrigger";
import { useServerNow } from "./serverClock";

/** How often a screen reads its timer, so a cue lands within 0.1 s of the
 * server-time crossing. */
export const READ_MS = 100;

const wholeSeconds = (seconds: number) => Math.ceil(seconds - 1e-9);

/** The match clock on these fields (the running match, else the last
 * ended one); null when there is none or no fields. */
export function useMatchReadingFrom(
  matches: LiveMatch[] | undefined,
  fieldIds: readonly number[]
): MatchReading | null {
  const now = useServerNow(READ_MS);
  const last = useRef<{ matchId: number; phase: string } | null>(null);
  let match = matches && fieldIds.length > 0 ? latestStartedMatchForFieldSet(matches, fieldIds) : null;
  // A live match reset to not started is no longer a started match; read it
  // once more so the reset shows as a stop.
  const lastLive = last.current !== null && last.current.phase !== "not_started" && last.current.phase !== "ended";
  if (lastLive && match?.id !== last.current?.matchId) {
    const reset = matches?.find((m) => m.id === last.current?.matchId && m.phase === "not_started");
    if (reset) match = reset;
  }
  const followedId = match?.id ?? null;
  const followedPhase = match?.phase ?? null;
  useEffect(() => {
    last.current = followedId === null || followedPhase === null ? null : { matchId: followedId, phase: followedPhase };
  }, [followedId, followedPhase]);
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

/** A skills timer's reading; `timerKey` names the timer, so another one
 * reads as new. */
export function useSkillsReading(timer: SkillsClockState | null, timerKey: string): SkillsReading | null {
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
  matchLoaded: boolean;
  skills: SkillsReading | null;
  timeout: number | null;
}

/** Stands in for "no match started yet on these fields", so the first match
 * of the day cues its whole count-in like every later one. */
const NO_MATCH: MatchReading = { matchId: -1, phase: "not_started", whole: 0, paused: false, endedEarly: false };

/** Calls `onCues` with the cues of one followed timer. `key` names which
 * timer: a change starts over from a first reading, which never cues.
 * `matchLoaded` says the matches and fields behind `match` have loaded, so a
 * null `match` means no match has started on them yet (not "still loading"). */
export function useTimerCues(
  input: {
    key: string;
    match: MatchReading | null;
    skills: SkillsReading | null;
    timeout: number | null;
    moments: readonly Moment[] | undefined;
    matchLoaded?: boolean;
  },
  onCues: (cues: Cue[]) => void
): void {
  const { moments } = input;
  const reading: FollowedReading = {
    key: input.key,
    match: input.match,
    matchLoaded: input.matchLoaded ?? false,
    skills: input.skills,
    timeout: input.timeout,
  };
  const compute = useCallback(
    (prev: FollowedReading | null, next: FollowedReading | null): Cue[] => {
      if (prev === null || next === null || prev.key !== next.key) return [];
      // A loaded reading with no match yet is "not started", not a first reading.
      const prevMatch = prev.match ?? (prev.matchLoaded ? NO_MATCH : null);
      return [
        ...matchCues(prevMatch, next.match, moments ?? []),
        ...skillsCues(prev.skills, next.skills),
        ...timeoutCues(prev.timeout, next.timeout),
      ];
    },
    [moments]
  );
  useCueTrigger(reading, compute, onCues);
}
