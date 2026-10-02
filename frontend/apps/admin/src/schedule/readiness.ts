import type { FieldRead, FieldSetRead, ParticipationRead, TeamSummary } from "../types";

export type ReadinessKey = "gamePlugin" | "timezone" | "teams" | "fields";

export interface ReadinessItem {
  key: ReadinessKey;
  ok: boolean;
}

export function checkReadiness(input: {
  gamePluginSelected: boolean;
  sessionTimezone: string | null;
  checkedInTeamCount: number;
  teamsNeeded: number;
  usableFieldCount: number;
}): ReadinessItem[] {
  return [
    { key: "gamePlugin", ok: input.gamePluginSelected },
    { key: "timezone", ok: input.sessionTimezone !== null },
    { key: "teams", ok: input.teamsNeeded > 0 && input.checkedInTeamCount >= input.teamsNeeded },
    { key: "fields", ok: input.usableFieldCount > 0 },
  ];
}

/** Fields the generator will use for this division: those in sets assigned to it (`null` = unassigned sets). */
export function countUsableFields(
  fieldSets: FieldSetRead[],
  fields: FieldRead[],
  divisionId: number | null
): number {
  const setIds = new Set(fieldSets.filter((fs) => fs.division_id === divisionId).map((fs) => fs.id));
  return fields.filter((field) => setIds.has(field.field_set_id)).length;
}

/** `divisionId: null` means a single-division event, where every checked-in team counts. */
export function countCheckedInTeams(
  teams: TeamSummary[],
  participants: ParticipationRead[],
  divisionId: number | null
): number {
  const checkedIn = new Set(participants.filter((p) => p.checked_in).map((p) => p.team_id));
  return teams.filter(
    (team) => checkedIn.has(team.id) && (divisionId === null || team.division_id === divisionId)
  ).length;
}
