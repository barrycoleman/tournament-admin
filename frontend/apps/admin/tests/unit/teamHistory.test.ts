import { describe, expect, it } from "vitest";
import { judgedWarning, otherAwards } from "../../src/awards/teamHistory";
import type { TeamAwardHistory } from "../../src/types";

const HISTORY: TeamAwardHistory[] = [
  {
    team_id: 1,
    awards: [
      { award_id: 10, award_name: "Design", kind: "judged", session_id: 4, session_label: "Friday" },
      { award_id: 20, award_name: "Champion", kind: "performance", session_id: 5, session_label: "Saturday" },
    ],
  },
  {
    team_id: 2,
    awards: [
      { award_id: 10, award_name: "Design", kind: "judged", session_id: 4, session_label: "Friday" },
      { award_id: 30, award_name: "Think", kind: "judged", session_id: 5, session_label: "Saturday" },
    ],
  },
  { team_id: 3, awards: [{ award_id: 31, award_name: "Inspire", kind: "judged", session_id: 5, session_label: "Saturday" }] },
];

describe("teamHistory", () => {
  it("warns about a judged award this session before one earlier in the season", () => {
    expect(judgedWarning(HISTORY, 2, 31, 5)).toBe("session");
    expect(judgedWarning(HISTORY, 1, 31, 5)).toBe("season");
    expect(judgedWarning(HISTORY, 4, 31, 5)).toBeNull();
  });

  it("ignores the award being chosen and performance awards", () => {
    expect(judgedWarning(HISTORY, 3, 31, 5)).toBeNull();
    expect(otherAwards(HISTORY, 3, 31)).toEqual([]);
    expect(otherAwards(HISTORY, 1, 31).map((a) => a.award_name)).toEqual(["Design", "Champion"]);
  });
});
