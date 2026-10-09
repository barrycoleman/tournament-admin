import type { TeamAwardEntry, TeamAwardHistory } from "../types";

/** The team's awards other than the one being chosen. */
export function otherAwards(history: TeamAwardHistory[], teamId: number, awardId: number): TeamAwardEntry[] {
  return (history.find((h) => h.team_id === teamId)?.awards ?? []).filter((a) => a.award_id !== awardId);
}

/** "session" if the team already won a judged award in this session, else
 * "season" if it won one earlier in the season, else null. */
export function judgedWarning(
  history: TeamAwardHistory[],
  teamId: number,
  awardId: number,
  sessionId: number
): "session" | "season" | null {
  const judged = otherAwards(history, teamId, awardId).filter((a) => a.kind === "judged");
  if (judged.some((a) => a.session_id === sessionId)) return "session";
  if (judged.length > 0) return "season";
  return null;
}
