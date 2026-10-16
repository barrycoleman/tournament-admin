import { describe, expect, it } from "vitest";
import {
  AUDIENCE_SCREENS,
  PIT_SCREENS,
  compareMatches,
  currentMatchForField,
  defaultSettings,
  formatClock,
  formatOffset,
  inDivision,
  lastScoredMatch,
  latestStartedMatchForFieldSet,
  nextMatchForFieldSet,
  remainingSeconds,
  runningMatchForFieldSet,
  startBand,
  upcomingMatches,
  type AllianceScore,
  type LiveMatch,
} from "../src";

let nextId = 1;
function match(overrides: Partial<LiveMatch> = {}): LiveMatch {
  const id = overrides.id ?? nextId++;
  return {
    id,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: id,
    label: `Q${id}`,
    field_id: 1,
    scheduled_time: null,
    status: "scheduled",
    phase: "not_started",
    phase_deadline: null,
    paused: false,
    remaining_seconds_at_pause: null,
    is_finals: false,
    alliances: [],
    ...overrides,
  };
}
const at = (minute: number) => `2026-11-07T16:${String(minute).padStart(2, "0")}:00Z`;
const score = (match_id: number, saved: string): AllianceScore => ({
  match_id, alliance_id: match_id * 10, score: 1, data: {}, teams: [], saved_at: saved,
});

describe("match order", () => {
  it("puts timed matches first by time, then untimed ones by id", () => {
    const untimedLater = match({ id: 50 });
    const untimed = match({ id: 40 });
    const late = match({ id: 3, scheduled_time: at(30) });
    const early = match({ id: 9, scheduled_time: at(10) });
    expect([untimedLater, late, untimed, early].sort(compareMatches).map((m) => m.id)).toEqual([9, 3, 40, 50]);
  });

  it("a field shows its earliest match without a complete score", () => {
    const done = match({ scheduled_time: at(1), status: "completed", phase: "ended" });
    const ended = match({ scheduled_time: at(2), phase: "ended" });
    const later = match({ scheduled_time: at(3) });
    const skipped = match({ scheduled_time: at(0), status: "not_played" });
    const elsewhere = match({ scheduled_time: at(0), field_id: 2 });
    expect(currentMatchForField([later, ended, done, skipped, elsewhere], 1)?.id).toBe(ended.id);
    expect(currentMatchForField([done], 1)).toBeNull();
  });

  it("prefers a running match on the field, then an ended one not fully scored, over an earlier unstarted one", () => {
    const q1 = match({ scheduled_time: at(0) });
    const q2 = match({ scheduled_time: at(1), phase: "ended" });
    const q3 = match({ scheduled_time: at(2), phase: "driver" });
    expect(currentMatchForField([q1, q2, q3], 1)?.id).toBe(q3.id);
    expect(currentMatchForField([q1, q2], 1)?.id).toBe(q2.id);
    expect(currentMatchForField([q1], 1)?.id).toBe(q1.id);
  });

  it("the field group's next match is the queued one when still valid, else the earliest unstarted", () => {
    const running = match({ scheduled_time: at(1), phase: "driver" });
    const first = match({ scheduled_time: at(2), field_id: 2 });
    const second = match({ scheduled_time: at(3) });
    const foreign = match({ scheduled_time: at(0), field_id: 9 });
    const all = [running, second, first, foreign];
    expect(nextMatchForFieldSet(all, [1, 2], null)?.id).toBe(first.id);
    expect(nextMatchForFieldSet(all, [1, 2], second.id)?.id).toBe(second.id);
    // A stale override (started, foreign or gone) is ignored.
    expect(nextMatchForFieldSet(all, [1, 2], running.id)?.id).toBe(first.id);
    expect(nextMatchForFieldSet(all, [1, 2], foreign.id)?.id).toBe(first.id);
    expect(nextMatchForFieldSet(all, [1, 2], 999)?.id).toBe(first.id);
  });

  it("finds the running match, and the latest started one after it ends", () => {
    const ended = match({ scheduled_time: at(1), phase: "ended" });
    const running = match({ scheduled_time: at(2), phase: "awaiting_driver" });
    expect(runningMatchForFieldSet([ended, running], [1])?.id).toBe(running.id);
    expect(latestStartedMatchForFieldSet([ended, running], [1])?.id).toBe(running.id);
    expect(latestStartedMatchForFieldSet([ended, match({ scheduled_time: at(3) })], [1])?.id).toBe(ended.id);
    expect(latestStartedMatchForFieldSet([match()], [1])).toBeNull();
  });

  it("the last scored match is the one saved most recently", () => {
    const a = match({ status: "completed", scheduled_time: at(5) });
    const b = match({ status: "completed", scheduled_time: at(1) });
    const c = match({ status: "completed", scheduled_time: at(9), field_id: 2 });
    const scores = [score(a.id, at(10)), score(b.id, at(20)), score(c.id, at(30))];
    expect(lastScoredMatch([a, b, c], scores, [1])?.id).toBe(b.id);
  });

  it("lists upcoming matches in order and filters by division", () => {
    const sole = 4;
    const a = match({ scheduled_time: at(2), division_id: null });
    const b = match({ scheduled_time: at(1), division_id: sole });
    const c = match({ scheduled_time: at(3), division_id: 5 });
    const started = match({ scheduled_time: at(0), phase: "driver" });
    expect(upcomingMatches([a, b, c, started], inDivision(sole, sole), 3).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(upcomingMatches([a, b, c], inDivision(null, sole), 2).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(upcomingMatches([a, b, c], inDivision(5, sole), 3).map((m) => m.id)).toEqual([c.id]);
  });
});

describe("clock", () => {
  it("bands the time to start: green above 30 s, yellow from 30 s to 0, red after", () => {
    expect(startBand(31_000)).toBe("early");
    expect(startBand(30_000)).toBe("soon");
    expect(startBand(0)).toBe("soon");
    expect(startBand(-1)).toBe("late");
  });

  it("formats clocks and offsets", () => {
    expect(formatClock(83)).toBe("1:23");
    expect(formatClock(59.2)).toBe("1:00");
    expect(formatClock(-4)).toBe("0:00");
    expect(formatOffset(83_000)).toBe("1:23");
    expect(formatOffset(-192_500)).toBe("3:12");
  });

  it("reads the remaining time from the deadline, or the frozen value while paused", () => {
    const now = Date.parse(at(0));
    expect(remainingSeconds({ paused: false, remaining_seconds_at_pause: null, phase_deadline: at(1) }, now)).toBe(60);
    expect(remainingSeconds({ paused: true, remaining_seconds_at_pause: 12.5, phase_deadline: null }, now)).toBe(12.5);
    expect(remainingSeconds({ paused: false, remaining_seconds_at_pause: null, phase_deadline: null }, now)).toBeNull();
  });
});

describe("screens", () => {
  it("audience groups get every screen and pit groups all but the match screens", () => {
    expect(AUDIENCE_SCREENS).toHaveLength(10);
    expect(PIT_SCREENS).not.toContain("in_match");
    expect(PIT_SCREENS).not.toContain("match_intro");
    expect(PIT_SCREENS).not.toContain("last_scored_match");
    expect(defaultSettings("upcoming_matches", "pit")).toEqual({ count: 3, scope: "division" });
    expect(defaultSettings("upcoming_matches", "audience")).toEqual({ count: 3, scope: "field_set" });
    expect(defaultSettings("logo", "audience")).toEqual({});
  });
});
