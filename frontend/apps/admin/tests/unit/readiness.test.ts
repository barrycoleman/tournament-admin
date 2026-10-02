import { describe, expect, it } from "vitest";
import { checkReadiness, countCheckedInTeams, countUsableFields } from "../../src/schedule/readiness";

describe("readiness", () => {
  it("passes every item when everything is in place", () => {
    expect(
      checkReadiness({
        gamePluginSelected: true,
        sessionTimezone: "America/Los_Angeles",
        checkedInTeamCount: 4,
        teamsNeeded: 4,
        usableFieldCount: 1,
      })
    ).toEqual([
      { key: "gamePlugin", ok: true },
      { key: "timezone", ok: true },
      { key: "teams", ok: true },
      { key: "fields", ok: true },
    ]);
  });

  it("fails items independently, and treats an unknown team requirement as not ready", () => {
    expect(
      checkReadiness({
        gamePluginSelected: false,
        sessionTimezone: null,
        checkedInTeamCount: 10,
        teamsNeeded: 0,
        usableFieldCount: 0,
      }).map((item) => item.ok)
    ).toEqual([false, false, false, false]);
  });

  it("counts only fields in field sets scoped to the division (null = unassigned)", () => {
    const fieldSets = [
      { id: 1, session_id: 1, name: "Unassigned", division_id: null },
      { id: 2, session_id: 1, name: "Blue", division_id: 2 },
    ];
    const fields = [
      { id: 10, field_set_id: 1, name: "A" },
      { id: 11, field_set_id: 2, name: "B" },
      { id: 12, field_set_id: 2, name: "C" },
    ];
    expect(countUsableFields(fieldSets, fields, null)).toBe(1);
    expect(countUsableFields(fieldSets, fields, 2)).toBe(2);
  });

  it("counts checked-in teams, scoped to a division only when one is given", () => {
    const teams = [
      { id: 1, number: "1", name: "A", division_id: 1 },
      { id: 2, number: "2", name: "B", division_id: 2 },
      { id: 3, number: "3", name: "C", division_id: 2 },
    ];
    const participants = [
      { id: 1, session_id: 1, team_id: 1, checked_in: true },
      { id: 2, session_id: 1, team_id: 2, checked_in: true },
      { id: 3, session_id: 1, team_id: 3, checked_in: false },
    ];
    expect(countCheckedInTeams(teams, participants, null)).toBe(2);
    expect(countCheckedInTeams(teams, participants, 2)).toBe(1);
  });
});
