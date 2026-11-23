import type { Participant, Team } from "../api";
import { compareTeamNumbers } from "./schedule";

export interface CheckinSummary {
  rows: { team: Team; checkedIn: boolean }[];
  checkedIn: number;
  total: number;
}

/** The session's participating teams that pass the screen's division filter,
 * in team-number order. A participant whose team is unknown is left out. */
export function checkinSummary(
  participants: Participant[],
  teams: Map<number, Team>,
  keep: (row: { division_id: number | null }) => boolean
): CheckinSummary {
  const rows: CheckinSummary["rows"] = [];
  for (const participant of participants) {
    const team = teams.get(participant.team_id);
    if (team && keep(team)) rows.push({ team, checkedIn: participant.checked_in });
  }
  rows.sort((a, b) => compareTeamNumbers(a.team.number, b.team.number));
  return { rows, checkedIn: rows.filter((r) => r.checkedIn).length, total: rows.length };
}
