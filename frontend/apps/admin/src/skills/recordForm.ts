import type { SkillsAttemptRead, TeamSummary } from "../types";

export interface AttemptStatus {
  used: number;
  next: number;
  usedUp: boolean;
}

export function attemptStatus(
  attempts: SkillsAttemptRead[],
  teamId: number,
  typeKey: string,
  allowed: number
): AttemptStatus {
  const used = attempts.filter((a) => a.team_id === teamId && a.skills_type === typeKey).length;
  return { used, next: used + 1, usedUp: used >= allowed };
}

export function compareTeamNumbers(a: TeamSummary, b: TeamSummary): number {
  return a.number.localeCompare(b.number, undefined, { numeric: true });
}

/** Whether the team's number or name contains the text: trimmed, case-insensitive, literal. Blank matches all. */
export function teamMatches(team: TeamSummary, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return !needle || team.number.toLowerCase().includes(needle) || team.name.toLowerCase().includes(needle);
}

export function matchTeams(teams: TeamSummary[], text: string): TeamSummary[] {
  return teams.filter((team) => teamMatches(team, text)).sort(compareTeamNumbers);
}
