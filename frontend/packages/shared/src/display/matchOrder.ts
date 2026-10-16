import type { AllianceScore, LiveMatch } from "./types";

/** "Fully scored" and "skipped at finalize": neither will be played. */
const FINISHED = new Set(["completed", "not_played"]);

/** Scheduled matches by time, then unscheduled ones (finals games) by id. */
export function compareMatches(a: LiveMatch, b: LiveMatch): number {
  const at = a.scheduled_time === null ? null : Date.parse(a.scheduled_time);
  const bt = b.scheduled_time === null ? null : Date.parse(b.scheduled_time);
  if (at !== null && bt !== null && at !== bt) return at - bt;
  if (at === null && bt !== null) return 1;
  if (at !== null && bt === null) return -1;
  return a.id - b.id;
}

export function sortMatches(matches: LiveMatch[]): LiveMatch[] {
  return [...matches].sort(compareMatches);
}

export function isRunning(match: LiveMatch): boolean {
  return match.phase !== "not_started" && match.phase !== "ended";
}

export function isFinished(match: LiveMatch): boolean {
  return FINISHED.has(match.status);
}

export function onFields(fieldIds: readonly number[]): (match: LiveMatch) => boolean {
  const ids = new Set(fieldIds);
  return (match) => match.field_id !== null && ids.has(match.field_id);
}

/** A division filter. Null means everything; the sole division of a
 * single-division event also takes the rows that carry no division. */
export function inDivision(
  divisionId: number | null,
  soleDivisionId: number | null
): (row: { division_id: number | null }) => boolean {
  return (row) =>
    divisionId === null ||
    row.division_id === divisionId ||
    (row.division_id === null && divisionId === soleDivisionId);
}

/** What a field display shows: a match running on the field, else one that
 * ended without a complete score, else the earliest not yet scored (an
 * operator can start a later match first, so order alone isn't enough). */
export function currentMatchForField(matches: LiveMatch[], fieldId: number): LiveMatch | null {
  const open = sortMatches(matches.filter((m) => m.field_id === fieldId && !isFinished(m)));
  return open.find(isRunning) ?? open.find((m) => m.phase === "ended") ?? open[0] ?? null;
}

/** What Start begins: the queued match while it is still an unstarted match
 * on this field group, else the earliest unstarted one. */
export function nextMatchForFieldSet(
  matches: LiveMatch[],
  fieldIds: readonly number[],
  queuedMatchId: number | null
): LiveMatch | null {
  const onSet = onFields(fieldIds);
  const candidates = sortMatches(matches.filter((m) => onSet(m) && m.phase === "not_started" && !isFinished(m)));
  if (queuedMatchId !== null) {
    const queued = candidates.find((m) => m.id === queuedMatchId);
    if (queued) return queued;
  }
  return candidates[0] ?? null;
}

export function runningMatchForFieldSet(matches: LiveMatch[], fieldIds: readonly number[]): LiveMatch | null {
  const onSet = onFields(fieldIds);
  return sortMatches(matches.filter((m) => onSet(m) && isRunning(m)))[0] ?? null;
}

/** The running match, else the last one in order that has ended. */
export function latestStartedMatchForFieldSet(matches: LiveMatch[], fieldIds: readonly number[]): LiveMatch | null {
  const running = runningMatchForFieldSet(matches, fieldIds);
  if (running) return running;
  const onSet = onFields(fieldIds);
  const ended = sortMatches(matches.filter((m) => onSet(m) && m.phase === "ended"));
  return ended[ended.length - 1] ?? null;
}

function latestSave(matchId: number, scores: AllianceScore[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const row of scores) {
    if (row.match_id === matchId && row.saved_at !== null) latest = Math.max(latest, Date.parse(row.saved_at));
  }
  return latest;
}

/** Fully scored matches, the most recently saved first. */
export function scoredMatches(
  matches: LiveMatch[],
  scores: AllianceScore[],
  keep: (match: LiveMatch) => boolean = () => true
): LiveMatch[] {
  return matches
    .filter((m) => m.status === "completed" && keep(m))
    .sort((a, b) => latestSave(b.id, scores) - latestSave(a.id, scores) || compareMatches(b, a));
}

export function lastScoredMatch(
  matches: LiveMatch[],
  scores: AllianceScore[],
  fieldIds: readonly number[]
): LiveMatch | null {
  return scoredMatches(matches, scores, onFields(fieldIds))[0] ?? null;
}

export function upcomingMatches(
  matches: LiveMatch[],
  keep: (match: LiveMatch) => boolean,
  count: number
): LiveMatch[] {
  return sortMatches(matches.filter((m) => keep(m) && m.phase === "not_started" && !isFinished(m))).slice(0, count);
}
