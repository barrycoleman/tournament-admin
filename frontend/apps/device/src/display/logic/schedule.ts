import { currentMatchForField, isFinished, isRunning, sortMatches, type LiveMatch } from "@tournament-admin/shared";
import type { Field } from "../api";

export type ScheduleRound = "practice" | "qualification" | "elimination";

const isPlayable = (match: LiveMatch) => match.status !== "not_played";

/** The schedule's rows: skipped matches dropped, in time order, starting
 * `lead` played matches before the earliest unplayed one. When every match is
 * played the whole list is returned. */
export function scheduleRows(matches: LiveMatch[], lead = 2): LiveMatch[] {
  const rows = sortMatches(matches.filter(isPlayable));
  const firstOpen = rows.findIndex((m) => !isFinished(m));
  if (firstOpen < 0) return rows;
  return rows.slice(Math.max(0, firstOpen - lead));
}

/** The match each field's own TV shows (see currentMatchForField). */
export function onFieldMatchIds(matches: LiveMatch[], fieldIds: number[]): Set<number> {
  const ids = new Set<number>();
  for (const fieldId of fieldIds) {
    const current = currentMatchForField(matches, fieldId);
    if (current) ids.add(current.id);
  }
  return ids;
}

/** Running, or ended but not yet scored. */
export function isOnFieldNow(match: LiveMatch): boolean {
  return isRunning(match) || (match.phase === "ended" && !isFinished(match));
}

const roundOf = (match: LiveMatch): ScheduleRound =>
  match.round_type === "practice" || match.round_type === "qualification" ? match.round_type : "elimination";

/** The round of the earliest unplayed match, with played and total in that round. */
export function roundProgress(matches: LiveMatch[]): { round: ScheduleRound; played: number; total: number } | null {
  const rows = sortMatches(matches.filter(isPlayable));
  const next = rows.find((m) => !isFinished(m));
  if (!next) return null;
  const round = roundOf(next);
  const inRound = rows.filter((m) => roundOf(m) === round);
  return { round, played: inRound.filter(isFinished).length, total: inRound.length };
}

/** The field's name when short, else "F" and its 1-based position by id. */
/** The field's own name, as every other screen shows it; empty for no field. */
export function fieldName(fields: Field[], fieldId: number | null): string {
  if (fieldId === null) return "";
  return fields.find((f) => f.id === fieldId)?.name ?? "";
}

export function compareTeamNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** A team's next unfinished matches in time order. */
export function nextMatchesForTeam(matches: LiveMatch[], teamId: number, count = 3): LiveMatch[] {
  return sortMatches(matches.filter((m) => isPlayable(m) && !isFinished(m) && m.alliances.some((a) => a.team_ids.includes(teamId)))).slice(0, count);
}
