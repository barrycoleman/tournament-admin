import type { MatchRead } from "../types";

export interface RoundSummary {
  roundType: string;
  matchCount: number;
  scoredCount: number;
  firstTime: string | null;
  lastTime: string | null;
}

/**
 * Schedule-generated rounds for one division (`null` = the no-division
 * scope a single-division event schedules into). Finals games are left
 * out: they share the plugin's "elimination" round type but are never
 * cleared by DELETE /api/schedule.
 */
export function summarizeRounds(matches: MatchRead[], divisionId: number | null): RoundSummary[] {
  const byRound = new Map<string, RoundSummary>();
  for (const match of matches) {
    if (match.is_finals || match.division_id !== divisionId) continue;
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
