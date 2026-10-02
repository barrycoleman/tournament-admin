import { describe, expect, it } from "vitest";
import {
  availableRoundTypes,
  buildScheduleRequest,
  defaultPhases,
  formatCycleTime,
  isCycleTimeTight,
  projectedFinish,
  roundTypeOptionsForRow,
  todayInZone,
  type ScheduleFormState,
} from "../../src/schedule/scheduleRequest";

const BASE: ScheduleFormState = {
  schedulerPluginName: "balanced",
  phases: [
    { roundType: "practice", matchesPerTeam: 1 },
    { roundType: "qualification", matchesPerTeam: 6 },
  ],
  timingMode: "fit",
  cycleMinutes: 7,
  blocks: [{ date: "2026-11-07", startTime: "09:00", endTime: "12:00" }],
};

describe("buildScheduleRequest", () => {
  it("builds a fit-mode request with null cycle times and no division_id for a single division", () => {
    const result = buildScheduleRequest(BASE, { sessionId: 1, divisionId: null, dryRun: true });
    expect(result).toEqual({
      ok: true,
      payload: {
        session_id: 1,
        scheduler_plugin_name: "balanced",
        phases: [
          { round_type: "practice", target_matches_per_team: 1 },
          { round_type: "qualification", target_matches_per_team: 6 },
        ],
        time_blocks: [{ date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time: null }],
        dry_run: true,
      },
    });
  });

  it("includes division_id when a division is selected", () => {
    const result = buildScheduleRequest(BASE, { sessionId: 1, divisionId: 2, dryRun: false });
    expect(result.ok && result.payload.division_id).toBe(2);
    expect(result.ok && result.payload.dry_run).toBe(false);
  });

  it("sorts blocks ascending by date and start time", () => {
    const state: ScheduleFormState = {
      ...BASE,
      blocks: [
        { date: "2026-11-08", startTime: "09:00", endTime: "11:00" },
        { date: "2026-11-07", startTime: "13:00", endTime: "17:00" },
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
      ],
    };
    const result = buildScheduleRequest(state, { sessionId: 1, divisionId: null, dryRun: true });
    expect(result.ok && result.payload.time_blocks.map((b) => `${b.date} ${b.start_time}`)).toEqual([
      "2026-11-07 09:00",
      "2026-11-07 13:00",
      "2026-11-08 09:00",
    ]);
  });

  it("fixed mode sends the cycle time in seconds and allows only the last block to be open-ended", () => {
    const state: ScheduleFormState = {
      ...BASE,
      timingMode: "fixed",
      cycleMinutes: 8,
      blocks: [
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
        { date: "2026-11-07", startTime: "13:00", endTime: "" },
      ],
    };
    const result = buildScheduleRequest(state, { sessionId: 1, divisionId: null, dryRun: true });
    expect(result.ok && result.payload.time_blocks).toEqual([
      { date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time: 480 },
      { date: "2026-11-07", start_time: "13:00", end_time: null, cycle_time: 480 },
    ]);

    const earlyBlank: ScheduleFormState = {
      ...state,
      blocks: [
        { date: "2026-11-07", startTime: "09:00", endTime: "" },
        { date: "2026-11-07", startTime: "13:00", endTime: "15:00" },
      ],
    };
    expect(buildScheduleRequest(earlyBlank, { sessionId: 1, divisionId: null, dryRun: true })).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.endTimeRequiredExceptLast",
    });
  });

  it("reports the first problem as an i18n error key", () => {
    const opts = { sessionId: 1, divisionId: null, dryRun: true };
    expect(buildScheduleRequest({ ...BASE, schedulerPluginName: "" }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.noScheduler",
    });
    expect(buildScheduleRequest({ ...BASE, phases: [] }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.noPhases",
    });
    expect(
      buildScheduleRequest({ ...BASE, phases: [{ roundType: "practice", matchesPerTeam: 0 }] }, opts)
    ).toEqual({ ok: false, errorKey: "sessions.schedule.form.errors.invalidPhase" });
    expect(buildScheduleRequest({ ...BASE, blocks: [] }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.noBlocks",
    });
    expect(
      buildScheduleRequest({ ...BASE, blocks: [{ date: "", startTime: "09:00", endTime: "12:00" }] }, opts)
    ).toEqual({ ok: false, errorKey: "sessions.schedule.form.errors.blockIncomplete" });
    expect(
      buildScheduleRequest({ ...BASE, blocks: [{ date: "2026-11-07", startTime: "09:00", endTime: "" }] }, opts)
    ).toEqual({ ok: false, errorKey: "sessions.schedule.form.errors.endTimeRequired" });
    expect(buildScheduleRequest({ ...BASE, timingMode: "fixed", cycleMinutes: 0 }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.cycleRequired",
    });
  });
});

describe("round-type helpers", () => {
  it("drops round types that already have a schedule", () => {
    expect(availableRoundTypes(["practice", "qualification", "elimination"], ["practice"])).toEqual([
      "qualification",
      "elimination",
    ]);
  });

  it("defaults to practice x1 then qualification x6, each only if available", () => {
    expect(defaultPhases(["practice", "qualification", "elimination"])).toEqual([
      { roundType: "practice", matchesPerTeam: 1 },
      { roundType: "qualification", matchesPerTeam: 6 },
    ]);
    expect(defaultPhases(["qualification", "elimination"])).toEqual([
      { roundType: "qualification", matchesPerTeam: 6 },
    ]);
    expect(defaultPhases(["elimination"])).toEqual([{ roundType: "elimination", matchesPerTeam: 1 }]);
    expect(defaultPhases([])).toEqual([]);
  });

  it("excludes round types chosen in other rows from a row's options", () => {
    const phases = [
      { roundType: "practice", matchesPerTeam: 1 },
      { roundType: "qualification", matchesPerTeam: 6 },
    ];
    expect(roundTypeOptionsForRow(["practice", "qualification", "elimination"], phases, 0)).toEqual([
      "practice",
      "elimination",
    ]);
  });
});

describe("timing helpers", () => {
  it("projects an open-ended block's finish, rolling past midnight", () => {
    expect(projectedFinish({ start_time: "13:00", time_slot_count: 10, cycle_time_seconds: 480 })).toEqual({
      time: "14:20",
      dayOffset: 0,
    });
    expect(projectedFinish({ start_time: "23:00", time_slot_count: 3, cycle_time_seconds: 1800 })).toEqual({
      time: "00:30",
      dayOffset: 1,
    });
  });

  it("formats cycle time as m:ss", () => {
    expect(formatCycleTime(450)).toBe("7:30");
    expect(formatCycleTime(480.4)).toBe("8:00");
  });

  it("flags a cycle time below 1.5x the match duration", () => {
    expect(isCycleTimeTight(2.5, 120)).toBe(true);
    expect(isCycleTimeTight(3, 120)).toBe(false);
    expect(isCycleTimeTight(0, 120)).toBe(false);
  });

  it("gives today's date in a timezone as YYYY-MM-DD", () => {
    const now = new Date("2026-11-08T03:00:00Z");
    expect(todayInZone("America/Los_Angeles", now)).toBe("2026-11-07");
    expect(todayInZone(null, now)).toBe("2026-11-08");
  });
});
