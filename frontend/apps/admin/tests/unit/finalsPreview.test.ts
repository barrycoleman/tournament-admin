import { describe, expect, it } from "vitest";
import {
  allianceCount,
  defaultRoundChoices,
  finalsColumn,
  roundLabels,
  winsToAdvance,
} from "../../src/finals/finalsPreview";

/** Team ids equal their rank, so rank N is team N. */
const RANKED_31 = Array.from({ length: 31 }, (_, index) => index + 1);

describe("finalsColumn", () => {
  it("makes the first teamCount/2 non-excluded teams captains when partner picking", () => {
    const column = finalsColumn(RANKED_31, new Set([3]), 16, "picking");
    expect(column.get(1)).toEqual({ kind: "captain", n: 1 });
    expect(column.get(3)).toEqual({ kind: "excluded" });
    expect(column.get(4)).toEqual({ kind: "captain", n: 3 });
    expect(column.get(9)).toEqual({ kind: "captain", n: 8 });
    expect(column.get(10)).toEqual({ kind: "invitable" });
    expect(column.get(29)).toEqual({ kind: "invitable" });
  });

  it("puts the second-lowest team in two score-chase alliances with an odd count and leaves nobody out", () => {
    const column = finalsColumn(RANKED_31, new Set(), 31, "score_chase");
    expect(column.get(30)).toEqual({ kind: "alliance", n: 15, n2: 16 });
    expect(column.get(31)).toEqual({ kind: "alliance", n: 16 });
    expect(column.get(1)).toEqual({ kind: "alliance", n: 1 });
    expect([...column.values()].some((cell) => cell.kind === "out")).toBe(false);
  });

  it("drops the lowest team from an odd knockout count", () => {
    const column = finalsColumn(RANKED_31, new Set(), 31, "pairs_knockout");
    expect(column.get(29)).toEqual({ kind: "alliance", n: 15 });
    expect(column.get(30)).toEqual({ kind: "alliance", n: 15 });
    expect(column.get(31)).toEqual({ kind: "out" });
  });

  it("marks a finalist that moved up because of an exclusion", () => {
    const column = finalsColumn(RANKED_31, new Set([3]), 16, "pairs_knockout");
    expect(column.get(4)).toEqual({ kind: "alliance", n: 2 });
    expect(column.get(17)).toEqual({ kind: "alliance", n: 8, movedUp: true });
    expect(column.get(18)).toEqual({ kind: "out" });
  });
});

describe("allianceCount", () => {
  it("counts alliances the way the server forms them", () => {
    expect(allianceCount(16, "picking")).toBe(8);
    expect(allianceCount(31, "pairs_knockout")).toBe(15);
    expect(allianceCount(31, "score_chase")).toBe(16);
  });
});

describe("rounds", () => {
  it("names the rounds from the first to the final", () => {
    expect(roundLabels(8)).toEqual(["quarterFinals", "semiFinals", "final"]);
    expect(roundLabels(15)).toEqual(["roundOf16", "quarterFinals", "semiFinals", "final"]);
    expect(roundLabels(2)).toEqual(["final"]);
  });

  it("defaults to single matches with a best 2 of 3 final", () => {
    expect(winsToAdvance(defaultRoundChoices(roundLabels(8).length))).toEqual([1, 1, 2]);
    expect(winsToAdvance(["single", "best2of3", "best3of5"])).toEqual([1, 2, 3]);
  });
});
