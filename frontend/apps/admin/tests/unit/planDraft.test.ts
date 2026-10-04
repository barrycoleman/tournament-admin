import { describe, expect, it } from "vitest";
import {
  buildPlanRequest,
  defaultCycleSeconds,
  fallbackCycleSeconds,
  formatCycle,
  initialRows,
  isRowChanged,
  mergeServerRounds,
  newRow,
  planAction,
  plannerRoundTypes,
  rowsToSend,
  rowsValid,
  splitCycle,
  type RoundRow,
} from "../../src/schedule/planDraft";
import type { ScheduledRound } from "../../src/types";

function scheduled(overrides: Partial<ScheduledRound>): ScheduledRound {
  return {
    round_type: "practice",
    target_matches_per_team: 1,
    cycle_time_seconds: 420,
    match_count: 6,
    scored_count: 0,
    first_start: "2026-11-07T17:00:00Z",
    last_end: "2026-11-07T17:37:00Z",
    locked: false,
    outside_playing_windows: false,
    ...overrides,
  };
}

const PRACTICE = scheduled({});
const QUALIFICATION = scheduled({
  round_type: "qualification",
  target_matches_per_team: 6,
  match_count: 36,
  first_start: "2026-11-07T17:42:00Z",
});
const cycleFor = () => 420;

describe("defaults", () => {
  it("leaves elimination out of the planner's round types", () => {
    expect(plannerRoundTypes(["practice", "qualification", "elimination"])).toEqual(["practice", "qualification"]);
  });

  it("falls back to the match length plus two minutes, rounded up to a whole minute", () => {
    expect(fallbackCycleSeconds(120)).toBe(240);
    expect(fallbackCycleSeconds(150)).toBe(300);
  });

  it("prefers the previous row, then the session's last cycle, then the plugin default", () => {
    const previous = newRow("practice", 1, 400, "new-1");
    expect(defaultCycleSeconds({ previousRow: previous, sessionLast: 450, pluginDefault: 300, matchSeconds: 120 })).toBe(400);
    expect(defaultCycleSeconds({ sessionLast: 450, pluginDefault: 300, matchSeconds: 120 })).toBe(450);
    expect(defaultCycleSeconds({ sessionLast: null, pluginDefault: 300, matchSeconds: 120 })).toBe(300);
    expect(defaultCycleSeconds({ sessionLast: null, pluginDefault: null, matchSeconds: 120 })).toBe(240);
  });
});

describe("initialRows", () => {
  it("pre-fills Practice x1 and Qualification x6 when nothing is scheduled", () => {
    const rows = initialRows([], ["practice", "qualification"], cycleFor);
    expect(rows.map((r) => [r.roundType, r.matchesPerTeam, r.cycleSeconds, r.scheduled])).toEqual([
      ["practice", 1, 420, null],
      ["qualification", 6, 420, null],
    ]);
  });

  it("shows only the scheduled rounds once anything is scheduled", () => {
    const rows = initialRows([PRACTICE], ["practice", "qualification"], cycleFor);
    expect(rows.map((r) => r.key)).toEqual(["practice"]);
    expect(isRowChanged(rows[0])).toBe(false);
  });
});

describe("what Apply sends", () => {
  const base = initialRows([PRACTICE, QUALIFICATION], ["practice", "qualification"], cycleFor);

  it("sends nothing when nothing changed", () => {
    expect(rowsToSend(base)).toEqual([]);
    expect(planAction(base)).toBe("none");
  });

  it("sends a changed row and every row after it", () => {
    const rows = base.map((r) => (r.key === "practice" ? { ...r, matchesPerTeam: 2 } : r));
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["practice", "qualification"]);
    expect(planAction(rows)).toBe("apply");
  });

  it("sends only the last row when only it changed", () => {
    const rows = base.map((r) => (r.key === "qualification" ? { ...r, cycleSeconds: 410 } : r));
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["qualification"]);
  });

  it("generates when only new rows are pending", () => {
    const rows: RoundRow[] = [base[0], newRow("qualification", 6, 420, "new-1")];
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["new-1"]);
    expect(planAction(rows)).toBe("generate");
  });

  it("rebuilds an unlocked round that now falls outside the playing times", () => {
    const rows = initialRows([scheduled({ outside_playing_windows: true })], [], cycleFor);
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["practice"]);
  });

  it("builds the request body, with a division only when there is one", () => {
    const rows = base.map((r) => (r.key === "qualification" ? { ...r, matchesPerTeam: 8 } : r));
    expect(
      buildPlanRequest(rowsToSend(rows), { sessionId: 1, divisionId: null, schedulerPluginName: "balanced", dryRun: true })
    ).toEqual({
      session_id: 1,
      scheduler_plugin_name: "balanced",
      rounds: [{ round_type: "qualification", target_matches_per_team: 8, cycle_time_seconds: 420 }],
      dry_run: true,
    });
    expect(
      buildPlanRequest(rowsToSend(rows), { sessionId: 1, divisionId: 2, schedulerPluginName: "balanced", dryRun: false })
        .division_id
    ).toBe(2);
  });
});

describe("validation and cycle formatting", () => {
  it("needs at least one match per team and a cycle no shorter than the match", () => {
    expect(rowsValid([newRow("practice", 1, 120, "a")], 120)).toBe(true);
    expect(rowsValid([newRow("practice", 0, 300, "a")], 120)).toBe(false);
    expect(rowsValid([newRow("practice", 1, 119, "a")], 120)).toBe(false);
    expect(rowsValid([newRow("practice", 1, Number.NaN, "a")], 120)).toBe(false);
  });

  it("formats and splits cycle times", () => {
    expect(formatCycle(410)).toBe("6:50");
    expect(formatCycle(420)).toBe("7:00");
    expect(splitCycle(410)).toEqual({ minutes: 6, seconds: 50 });
  });
});

describe("mergeServerRounds", () => {
  it("keeps this admin's unlocked edits when the server's rounds refresh", () => {
    const rows = initialRows([PRACTICE, QUALIFICATION], [], cycleFor).map((r) =>
      r.key === "qualification" ? { ...r, matchesPerTeam: 8 } : r
    );
    const { rows: merged, dropped } = mergeServerRounds(rows, [PRACTICE, { ...QUALIFICATION, match_count: 40 }], 420);
    expect(merged.find((r) => r.key === "qualification")?.matchesPerTeam).toBe(8);
    expect(merged.find((r) => r.key === "qualification")?.scheduled?.match_count).toBe(40);
    expect(dropped).toEqual([]);
  });

  it("adopts the server's new values for an unedited row", () => {
    const rows = initialRows([PRACTICE, QUALIFICATION], [], cycleFor);
    const { rows: merged } = mergeServerRounds(
      rows,
      [PRACTICE, { ...QUALIFICATION, target_matches_per_team: 8, cycle_time_seconds: 400 }],
      420
    );
    const qual = merged.find((r) => r.key === "qualification")!;
    expect([qual.matchesPerTeam, qual.cycleSeconds]).toEqual([8, 400]);
    expect(isRowChanged(qual)).toBe(false);
  });

  it("drops an edit to a round that became locked, and says so", () => {
    const rows = initialRows([PRACTICE], [], cycleFor).map((r) => ({ ...r, matchesPerTeam: 2 }));
    const { rows: merged, dropped } = mergeServerRounds(rows, [{ ...PRACTICE, locked: true, scored_count: 1 }], 420);
    expect(merged[0].matchesPerTeam).toBe(1);
    expect(dropped).toEqual(["practice"]);
  });

  it("replaces a new row once its round is scheduled, and keeps other new rows", () => {
    const rows: RoundRow[] = [newRow("practice", 1, 420, "new-1"), newRow("qualification", 6, 420, "new-2")];
    const { rows: merged } = mergeServerRounds(rows, [PRACTICE], 420);
    expect(merged.map((r) => r.key)).toEqual(["practice", "new-2"]);
    expect(isRowChanged(merged[0])).toBe(false);
  });

  it("clears the changed flag once an applied change comes back from the server", () => {
    const rows = initialRows([PRACTICE], [], cycleFor).map((r) => ({ ...r, matchesPerTeam: 2 }));
    const { rows: merged } = mergeServerRounds(rows, [{ ...PRACTICE, target_matches_per_team: 2 }], 420);
    expect(isRowChanged(merged[0])).toBe(false);
  });
});
