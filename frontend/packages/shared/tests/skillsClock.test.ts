import { describe, expect, it } from "vitest";
import { skillsClockActions, skillsClockPhase, skillsClockSeconds, type SkillsClockState } from "../src";

const NOW = Date.parse("2026-11-07T16:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const timer = (overrides: Partial<SkillsClockState> = {}): SkillsClockState => ({
  phase: "ready",
  deadline: null,
  paused: false,
  remaining_seconds: null,
  ...overrides,
});

describe("skills clock", () => {
  it("shows the full run length while ready", () => {
    expect(skillsClockSeconds(timer(), NOW, 60)).toBe(60);
    expect(skillsClockSeconds(timer({ remaining_seconds: 42 }), NOW, 60)).toBe(42);
    expect(skillsClockSeconds(timer(), NOW, null)).toBe(0);
  });

  it("counts down to the deadline while running and freezes while paused", () => {
    expect(skillsClockSeconds(timer({ phase: "running", deadline: at(45_000) }), NOW, 60)).toBe(45);
    expect(skillsClockSeconds(timer({ phase: "running", paused: true, remaining_seconds: 12 }), NOW, 60)).toBe(12);
  });

  it("reads a running timer past its deadline as ended, as the server does", () => {
    const late = timer({ phase: "running", deadline: at(-1) });
    expect(skillsClockPhase(late, NOW)).toBe("ended");
    expect(skillsClockSeconds(late, NOW, 60)).toBe(0);
    expect(skillsClockPhase(timer({ phase: "running", paused: true, deadline: at(-1) }), NOW)).toBe("running");
  });

  it("offers Start when ready, Pause or Resume with End and Reset while running, and Reset once ended", () => {
    expect(skillsClockActions(timer(), NOW)).toEqual(["start"]);
    expect(skillsClockActions(timer({ phase: "running", deadline: at(5_000) }), NOW)).toEqual(["pause", "end", "reset"]);
    expect(skillsClockActions(timer({ phase: "running", paused: true, remaining_seconds: 5 }), NOW)).toEqual([
      "resume",
      "end",
      "reset",
    ]);
    expect(skillsClockActions(timer({ phase: "ended" }), NOW)).toEqual(["reset"]);
  });
});
