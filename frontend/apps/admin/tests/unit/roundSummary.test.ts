import { describe, expect, it } from "vitest";
import { summarizeRounds } from "../../src/schedule/roundSummary";
import type { MatchRead } from "../../src/types";

function match(overrides: Partial<MatchRead>): MatchRead {
  return {
    id: 1,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: 1,
    label: "Q1",
    field_id: 100,
    time_slot: 0,
    scheduled_time: "2026-11-07T17:00:00Z",
    status: "scheduled",
    is_finals: false,
    alliances: [],
    ...overrides,
  };
}

describe("summarizeRounds", () => {
  it("groups by round type, counts scored matches, and orders rounds by first match time", () => {
    const matches = [
      match({ id: 1, round_type: "qualification", scheduled_time: "2026-11-07T18:00:00Z", status: "completed" }),
      match({ id: 2, round_type: "qualification", scheduled_time: "2026-11-07T19:00:00Z" }),
      match({ id: 3, round_type: "practice", scheduled_time: "2026-11-07T17:00:00Z" }),
    ];
    expect(summarizeRounds(matches, null)).toEqual([
      {
        roundType: "practice",
        matchCount: 1,
        scoredCount: 0,
        firstTime: "2026-11-07T17:00:00Z",
        lastTime: "2026-11-07T17:00:00Z",
      },
      {
        roundType: "qualification",
        matchCount: 2,
        scoredCount: 1,
        firstTime: "2026-11-07T18:00:00Z",
        lastTime: "2026-11-07T19:00:00Z",
      },
    ]);
  });

  it("excludes finals games and other divisions", () => {
    const matches = [
      match({ id: 1, round_type: "elimination", is_finals: true }),
      match({ id: 2, division_id: 2 }),
      match({ id: 3, division_id: null }),
    ];
    expect(summarizeRounds(matches, null).map((r) => [r.roundType, r.matchCount])).toEqual([
      ["qualification", 1],
    ]);
    expect(summarizeRounds(matches, 2).map((r) => [r.roundType, r.matchCount])).toEqual([
      ["qualification", 1],
    ]);
  });
});
