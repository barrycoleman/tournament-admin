import type { LiveMatch } from "./types";

export const COUNT_IN_PHASES: ReadonlySet<string> = new Set(["countdown_autonomous", "countdown_driver"]);
export const PERIOD_PHASES: ReadonlySet<string> = new Set(["autonomous", "driver"]);
/** Yellow from here down to the scheduled start. */
export const START_SOON_MS = 30_000;

export function remainingSeconds(
  match: Pick<LiveMatch, "paused" | "remaining_seconds_at_pause" | "phase_deadline">,
  nowMs: number
): number | null {
  if (match.paused) return match.remaining_seconds_at_pause ?? null;
  if (match.phase_deadline === null) return null;
  return Math.max(0, (Date.parse(match.phase_deadline) - nowMs) / 1000);
}

/** "m:ss", rounding up so a clock reads 0:00 only when time is up. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds - 1e-9));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type StartBand = "early" | "soon" | "late";

/** Green while more than 30 s remain, yellow from 30 s to 0, red after. */
export function startBand(msToStart: number): StartBand {
  if (msToStart > START_SOON_MS) return "early";
  if (msToStart >= 0) return "soon";
  return "late";
}

/** The time to a start, or since it once late, as "m:ss". */
export function formatOffset(msToStart: number): string {
  return msToStart >= 0 ? formatClock(msToStart / 1000) : formatClock(Math.floor(-msToStart / 1000));
}

export function formatTime(iso: string, timeZone: string | null, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone ?? undefined,
  }).format(new Date(iso));
}
