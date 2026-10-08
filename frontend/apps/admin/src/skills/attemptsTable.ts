import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../types";
import { compareTeamNumbers, teamMatches } from "./recordForm";

export interface AttemptRow {
  team: TeamSummary;
  /** Type key -> attempts by number, padded with null up to the allowed count. */
  byType: Record<string, (SkillsAttemptRead | null)[]>;
  /** The session Overall: the sum of each type's best. */
  overall: number;
}

/** One row per team with at least one attempt, by team number. Attempts for unknown teams are skipped. */
export function buildAttemptRows(
  attempts: SkillsAttemptRead[],
  teams: TeamSummary[],
  types: SessionSkillsType[]
): AttemptRow[] {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const byTeam = new Map<number, SkillsAttemptRead[]>();
  for (const attempt of attempts) {
    byTeam.set(attempt.team_id, [...(byTeam.get(attempt.team_id) ?? []), attempt]);
  }
  const rows: AttemptRow[] = [];
  for (const [teamId, teamAttempts] of byTeam) {
    const team = teamById.get(teamId);
    if (!team) continue;
    const byType: AttemptRow["byType"] = {};
    let overall = 0;
    for (const type of types) {
      const ofType = teamAttempts.filter((a) => a.skills_type === type.key).sort((a, b) => a.number - b.number);
      const padded: (SkillsAttemptRead | null)[] = [...ofType];
      while (padded.length < type.allowed) padded.push(null);
      byType[type.key] = padded;
      if (ofType.length > 0) overall += Math.max(...ofType.map((a) => a.score));
    }
    rows.push({ team, byType, overall });
  }
  return rows.sort((a, b) => compareTeamNumbers(a.team, b.team));
}

export function filterAttemptRows(rows: AttemptRow[], text: string): AttemptRow[] {
  return rows.filter((row) => teamMatches(row.team, text));
}
