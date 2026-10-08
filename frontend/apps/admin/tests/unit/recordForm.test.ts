import { describe, expect, it } from "vitest";
import { attemptStatus, matchTeams, teamMatches } from "../../src/skills/recordForm";
import type { SkillsAttemptRead, TeamSummary } from "../../src/types";

function attempt(id: number, team_id: number, skills_type: string): SkillsAttemptRead {
  return { id, team_id, skills_type, number: 1, score: 10, data: {}, recorded_at: "", updated_at: "" };
}

const TEAMS: TeamSummary[] = [
  { id: 1, number: "10", name: "Alpha", division_id: null },
  { id: 2, number: "9", name: "Bravo (East)", division_id: null },
  { id: 3, number: "S1", name: "Skills One", division_id: null },
];

describe("recordForm", () => {
  it("counts the team's attempts of the type and says whether any are left", () => {
    const attempts = [attempt(1, 1, "driver"), attempt(2, 1, "driver"), attempt(3, 1, "autonomous"), attempt(4, 2, "driver")];
    expect(attemptStatus(attempts, 1, "driver", 3)).toEqual({ used: 2, next: 3, usedUp: false });
    expect(attemptStatus(attempts, 1, "driver", 2)).toEqual({ used: 2, next: 3, usedUp: true });
    expect(attemptStatus(attempts, 3, "driver", 1)).toEqual({ used: 0, next: 1, usedUp: false });
  });

  it("matches number or name, trimmed and case-insensitive, sorted by number", () => {
    expect(matchTeams(TEAMS, "").map((team) => team.number)).toEqual(["9", "10", "S1"]);
    expect(matchTeams(TEAMS, "  s1 ").map((team) => team.number)).toEqual(["S1"]);
    expect(matchTeams(TEAMS, "ALPHA").map((team) => team.number)).toEqual(["10"]);
    expect(matchTeams(TEAMS, "(").map((team) => team.number)).toEqual(["9"]);
    expect(teamMatches(TEAMS[0], "zz")).toBe(false);
  });
});
