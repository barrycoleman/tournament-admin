import type { MatchRead } from "../types";

export interface RoundSummary {
  roundType: string;
  matchCount: number;
  scoredCount: number;
  firstTime: string | null;
  lastTime: string | null;
}

function groupRounds(matches: MatchRead[]): RoundSummary[] {
  const byRound = new Map<string, RoundSummary>();
  for (const match of matches) {
    let summary = byRound.get(match.round_type);
    if (!summary) {
      summary = { roundType: match.round_type, matchCount: 0, scoredCount: 0, firstTime: null, lastTime: null };
      byRound.set(match.round_type, summary);
    }
    summary.matchCount += 1;
    if (match.status === "completed") summary.scoredCount += 1;
    const time = match.scheduled_time;
    if (time) {
      if (summary.firstTime === null || time < summary.firstTime) summary.firstTime = time;
      if (summary.lastTime === null || time > summary.lastTime) summary.lastTime = time;
    }
  }
  return [...byRound.values()].sort((a, b) => (a.firstTime ?? "").localeCompare(b.firstTime ?? ""));
}

/**
 * Schedule-generated rounds for one division (`null` = the no-division
 * scope a single-division event schedules into). Finals games are left
 * out: they share the plugin's "elimination" round type but are never
 * cleared by DELETE /api/schedule.
 */
export function summarizeRounds(matches: MatchRead[], divisionId: number | null): RoundSummary[] {
  return groupRounds(matches.filter((match) => !match.is_finals && match.division_id === divisionId));
}

export interface OutOfScopeRound {
  divisionId: number | null;
  summary: RoundSummary;
}

/**
 * Schedule-generated rounds sitting in a scope the current division count
 * no longer uses: division-scoped rounds in a single-division event, or
 * no-division rounds in a multi-division one. They are invisible to
 * summarizeRounds but still hold their fields, so they must stay clearable.
 */
export function summarizeOutOfScopeRounds(matches: MatchRead[], multiDivision: boolean): OutOfScopeRound[] {
  const stray = matches.filter(
    (match) => !match.is_finals && (multiDivision ? match.division_id === null : match.division_id !== null)
  );
  const scopes = [...new Set(stray.map((match) => match.division_id))];
  return scopes.flatMap((divisionId) =>
    groupRounds(stray.filter((match) => match.division_id === divisionId)).map((summary) => ({
      divisionId,
      summary,
    }))
  );
}
