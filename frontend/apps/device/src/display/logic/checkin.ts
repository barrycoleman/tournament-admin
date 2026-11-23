import type { Participant, Team } from "../api";
import { compareTeamNumbers } from "./schedule";

export interface CheckinSummary {
  rows: { team: Team; checkedIn: boolean }[];
  checkedIn: number;
  total: number;
}

/** Every team that passes the screen's division filter, in team-number order,
 * like the admin check-in grid: a team is checked in when its participation
 * row says so, and not checked in when it has no row yet (the server creates a
 * row only on the first check-in change). A participant whose team is unknown
 * is ignored. */
export function checkinSummary(
  participants: Participant[],
  teams: Map<number, Team>,
  keep: (row: { division_id: number | null }) => boolean
): CheckinSummary {
  const checked = new Map(participants.map((p) => [p.team_id, p.checked_in]));
  const rows: CheckinSummary["rows"] = [];
  for (const team of teams.values()) {
    if (keep(team)) rows.push({ team, checkedIn: checked.get(team.id) ?? false });
  }
  rows.sort((a, b) => compareTeamNumbers(a.team.number, b.team.number));
  return { rows, checkedIn: rows.filter((r) => r.checkedIn).length, total: rows.length };
}
