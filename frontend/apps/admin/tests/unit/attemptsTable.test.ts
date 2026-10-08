import { describe, expect, it } from "vitest";
import { buildAttemptRows, filterAttemptRows } from "../../src/skills/attemptsTable";
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../../src/types";

const TYPES: SessionSkillsType[] = [
  { key: "autonomous", label: "Autonomous", allowed: 3 },
  { key: "driver", label: "Driver", allowed: 2 },
];
const TEAMS: TeamSummary[] = [
  { id: 1, number: "10", name: "Alpha", division_id: null },
  { id: 2, number: "9", name: "Bots (East)", division_id: null },
  { id: 3, number: "S1", name: "Skills One", division_id: null },
];

function attempt(id: number, team_id: number, skills_type: string, number: number, score: number): SkillsAttemptRead {
  return { id, team_id, skills_type, number, score, data: {}, recorded_at: "", updated_at: "" };
}

const ATTEMPTS = [
  attempt(1, 1, "autonomous", 1, 20),
  attempt(2, 1, "autonomous", 2, 28),
  attempt(3, 1, "driver", 1, 30),
  attempt(4, 2, "driver", 1, 15),
  attempt(5, 2, "driver", 2, 18),
  attempt(6, 2, "driver", 3, 12), // more than allowed after the limit was lowered: still shown
  attempt(7, 99, "driver", 1, 50), // unknown team: skipped
];

describe("buildAttemptRows", () => {
  const rows = buildAttemptRows(ATTEMPTS, TEAMS, TYPES);

  it("has one row per team with attempts, by team number", () => {
    expect(rows.map((row) => row.team.number)).toEqual(["9", "10"]);
  });

  it("lists each type's attempts in order, padded to the allowed count", () => {
    const ten = rows[1];
    expect(ten.byType.autonomous.map((a) => a?.score ?? null)).toEqual([20, 28, null]);
    expect(ten.byType.driver.map((a) => a?.score ?? null)).toEqual([30, null]);
    expect(rows[0].byType.autonomous).toEqual([null, null, null]);
    expect(rows[0].byType.driver.map((a) => a?.score ?? null)).toEqual([15, 18, 12]);
  });

  it("adds each type's best for the Overall", () => {
    expect(rows[1].overall).toBe(58);
    expect(rows[0].overall).toBe(18);
  });
});

describe("filterAttemptRows", () => {
  const rows = buildAttemptRows(
    [...ATTEMPTS, attempt(8, 3, "driver", 1, 5)],
    TEAMS,
    TYPES
  );

  it("matches number or name, trimmed and case-insensitive", () => {
    expect(filterAttemptRows(rows, "  s1 ").map((row) => row.team.number)).toEqual(["S1"]);
    expect(filterAttemptRows(rows, "ALPHA").map((row) => row.team.number)).toEqual(["10"]);
    expect(filterAttemptRows(rows, "").map((row) => row.team.number)).toEqual(["9", "10", "S1"]);
  });

  it("treats regex characters literally", () => {
    expect(filterAttemptRows(rows, "(").map((row) => row.team.number)).toEqual(["9"]);
    expect(filterAttemptRows(rows, ".*")).toEqual([]);
  });
});
