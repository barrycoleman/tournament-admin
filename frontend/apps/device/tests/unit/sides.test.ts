import { describe, expect, it } from "vitest";
import { groupScore, matchSides, resultOutcome, scoreGroups } from "../../src/display/logic/sides";
import { match } from "./displayFixtures";

const solo = (ids: number[]) => match({ alliances: [{ id: 901, station: "solo", team_ids: ids }] });
const coop = () =>
  match({ alliances: [{ id: 1, station: "red", team_ids: [1] }, { id: 2, station: "blue", team_ids: [3] }] });

describe("matchSides", () => {
  it("puts head-to-head alliances on their sides whatever the order", () => {
    const m = match();
    m.alliances.reverse();
    expect(matchSides(m)).toEqual({ red: [1, 2], blue: [3, 4] });
  });
  it("puts cooperative teams on their sides", () => {
    expect(matchSides(coop())).toEqual({ red: [1], blue: [3] });
  });
  it("gives a solo run's better rank red", () => {
    expect(matchSides(solo([7, 3]), new Map([[7, 4], [3, 1]]))).toEqual({ red: [3], blue: [7] });
  });
  it("falls back to server order when a rank is missing or ranks are absent", () => {
    expect(matchSides(solo([7, 3]), new Map([[3, 1]]))).toEqual({ red: [7], blue: [3] });
    expect(matchSides(solo([7, 3]))).toEqual({ red: [7], blue: [3] });
  });
  it("shows a one-team solo run as red only", () => {
    expect(matchSides(solo([7]))).toEqual({ red: [7], blue: [] });
  });
});

describe("scoreGroups and results", () => {
  it("splits head-to-head and combines cooperative and solo", () => {
    expect(scoreGroups(match(), "head_to_head").map((g) => g.side)).toEqual(["red", "blue"]);
    expect(scoreGroups(coop(), "cooperative_score")).toEqual([{ side: "combined", allianceIds: [1, 2] }]);
    expect(scoreGroups(solo([7, 3]), "head_to_head")).toEqual([{ side: "combined", allianceIds: [901] }]);
  });
  it("names the winner, a tie, or nothing", () => {
    const groups = scoreGroups(match({ alliances: [{ id: 1, station: "red", team_ids: [1] }, { id: 2, station: "blue", team_ids: [2] }] }), "head_to_head");
    expect(resultOutcome(groups, new Map([[1, 48], [2, 52]]))).toBe("blue");
    expect(resultOutcome(groups, new Map([[1, 30], [2, 30]]))).toBe("tie");
    expect(resultOutcome(groups, new Map([[1, 30]]))).toBeNull();
    const combined = scoreGroups(coop(), "cooperative_score");
    expect(resultOutcome(combined, new Map([[1, 30], [2, 30]]))).toBeNull();
    expect(groupScore(combined[0], new Map([[1, 30], [2, 30]]))).toBe(30);
  });
});
