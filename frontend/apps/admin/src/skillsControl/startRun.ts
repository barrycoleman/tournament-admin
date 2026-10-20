import { attemptStatus, compareTeamNumbers } from "../skills/recordForm";
import type { ParticipationRead, SkillsAttemptRead, TeamSummary } from "../types";

/** Teams that may start a run of `skillsType`: checked in, not already on a
 * skills field, and with an attempt of that type left (the server checks again). */
export function eligibleTeams({
  teams,
  participants,
  attempts,
  skillsType,
  allowed,
  busyTeamIds,
}: {
  teams: TeamSummary[];
  participants: ParticipationRead[];
  attempts: SkillsAttemptRead[];
  skillsType: string;
  allowed: number;
  busyTeamIds: Set<number>;
}): TeamSummary[] {
  const checkedIn = new Set(participants.filter((row) => row.checked_in).map((row) => row.team_id));
  return teams
    .filter(
      (team) =>
        checkedIn.has(team.id) &&
        !busyTeamIds.has(team.id) &&
        !attemptStatus(attempts, team.id, skillsType, allowed).usedUp
    )
    .sort(compareTeamNumbers);
}

/** The newest attempt scored on this skills field, or null. */
export function lastFieldAttempt(attempts: SkillsAttemptRead[], fieldId: number): SkillsAttemptRead | null {
  let latest: SkillsAttemptRead | null = null;
  for (const attempt of attempts) {
    if (attempt.field_id === fieldId && (latest === null || attempt.id > latest.id)) latest = attempt;
  }
  return latest;
}
