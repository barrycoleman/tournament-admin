import { describe, expect, it } from "vitest";
import {
  SOUND_SLOTS,
  activeWindow,
  holdMatchReading,
  holdSkillsReading,
  matchCues,
  skillsCues,
  timeoutCues,
  type Cue,
  type MatchReading,
  type Moment,
  type SkillsReading,
} from "../src";

const reading = (phase: string, whole: number, extra: Partial<MatchReading> = {}): MatchReading => ({
  matchId: 1,
  phase,
  whole,
  paused: false,
  endedEarly: false,
  ...extra,
});

const skills = (
  phase: SkillsReading["phase"],
  whole: number,
  extra: Partial<SkillsReading> = {}
): SkillsReading => ({ timerKey: "set:1", phase, whole, paused: false, endedEarly: false, ...extra });

// The cue test game's moments: a driver-change window 8 -> 6 and an endgame instant at 4.
const CUE_GAME: Moment[] = [
  { key: "driver_change", label: "Driver change", period: "driver", at_remaining: 8, until_remaining: 6 },
  { key: "endgame", label: "Endgame", period: "driver", at_remaining: 4, until_remaining: null },
];
const DRIVER_CHANGE: Moment[] = [
  { key: "driver_change", label: "Driver change", period: "driver", at_remaining: 35, until_remaining: 25 },
];

const BEEP: Cue = { sound: "beep", flash: null };
const START: Cue = { sound: "start", flash: null };
const OVER: Cue = { sound: "buzzer", flash: { kind: "over", label: null } };
const STOP: Cue = { sound: "stop", flash: { kind: "stop", label: null } };
const moment = (label: string): Cue => ({ sound: "moment", flash: { kind: "moment", label } });

const LIVE_PHASES = ["countdown_autonomous", "autonomous", "awaiting_driver", "countdown_driver", "driver"];

describe("SOUND_SLOTS", () => {
  it("lists the five slots in order", () => {
    expect(SOUND_SLOTS).toEqual(["beep", "start", "buzzer", "moment", "stop"]);
  });
});

describe("matchCues", () => {
  it("is silent on the first reading and when the match goes away", () => {
    expect(matchCues(null, reading("driver", 50), [])).toEqual([]);
    expect(matchCues(reading("driver", 50), null, [])).toEqual([]);
  });

  it("beeps each count-in second, with no flash", () => {
    expect(matchCues(reading("not_started", 0), reading("countdown_autonomous", 3), [])).toEqual([BEEP]);
    expect(matchCues(reading("countdown_autonomous", 3), reading("countdown_autonomous", 2), [])).toEqual([BEEP]);
    expect(matchCues(reading("countdown_autonomous", 2), reading("countdown_autonomous", 1), [])).toEqual([BEEP]);
    expect(matchCues(reading("awaiting_driver", 0), reading("countdown_driver", 3), [])).toEqual([BEEP]);
    expect(matchCues(reading("countdown_driver", 2), reading("countdown_driver", 2), [])).toEqual([]);
  });

  it("plays the start sound entering autonomous and driver control", () => {
    expect(matchCues(reading("countdown_autonomous", 1), reading("autonomous", 15), [])).toEqual([START]);
    expect(matchCues(reading("countdown_driver", 1), reading("driver", 105), [])).toEqual([START]);
  });

  it("beeps once at each of 3, 2 and 1 in a section, and not at 30", () => {
    for (const phase of ["autonomous", "driver"]) {
      expect(matchCues(reading(phase, 4), reading(phase, 3), [])).toEqual([BEEP]);
      expect(matchCues(reading(phase, 3), reading(phase, 2), [])).toEqual([BEEP]);
      expect(matchCues(reading(phase, 2), reading(phase, 1), [])).toEqual([BEEP]);
      expect(matchCues(reading(phase, 3), reading(phase, 3), [])).toEqual([]);
      expect(matchCues(reading(phase, 31), reading(phase, 30), [])).toEqual([]);
    }
  });

  it("plays no sound when autonomous flows into waiting for driver control", () => {
    expect(matchCues(reading("autonomous", 1), reading("awaiting_driver", 0), [])).toEqual([]);
  });

  it("sounds the buzzer and the over flash when the match runs out", () => {
    expect(matchCues(reading("driver", 1), reading("ended", 0), [])).toEqual([OVER]);
    expect(matchCues(reading("driver", 0), reading("ended", 0), [])).toEqual([OVER]);
  });

  it("plays only the power-down and the stop flash when the operator ends it early", () => {
    expect(matchCues(reading("driver", 40), reading("ended", 0, { endedEarly: true }), [])).toEqual([STOP]);
    // The result depends only on endedEarly, never on how much time was left.
    expect(matchCues(reading("driver", 0), reading("ended", 0, { endedEarly: true }), [])).toEqual([STOP]);
    expect(matchCues(reading("driver", 1), reading("ended", 0, { endedEarly: false }), [])).toEqual([OVER]);
    expect(matchCues(reading("driver", 40), reading("ended", 0, { endedEarly: false }), [])).toEqual([OVER]);
    expect(matchCues(reading("awaiting_driver", 0), reading("ended", 0, { endedEarly: true }), [])).toEqual([STOP]);
    expect(
      matchCues(reading("autonomous", 5, { paused: true }), reading("ended", 0, { endedEarly: true }), [])
    ).toEqual([STOP]);
  });

  it("stops on a reset of any live phase, paused or not", () => {
    for (const phase of LIVE_PHASES) {
      for (const paused of [false, true]) {
        expect(matchCues(reading(phase, 5, { paused }), reading("not_started", 0), [])).toEqual([STOP]);
      }
    }
  });

  it("stops on a section reset back to waiting for driver control", () => {
    for (const phase of ["driver", "countdown_driver"]) {
      for (const paused of [false, true]) {
        expect(matchCues(reading(phase, 2, { paused }), reading("awaiting_driver", 0), [])).toEqual([STOP]);
      }
    }
  });

  it("is silent resetting or ending a match that isn't live", () => {
    expect(matchCues(reading("ended", 0), reading("not_started", 0), [])).toEqual([]);
    expect(matchCues(reading("ended", 0, { endedEarly: true }), reading("not_started", 0), [])).toEqual([]);
    expect(matchCues(reading("not_started", 0), reading("ended", 0, { endedEarly: true }), [])).toEqual([]);
    expect(matchCues(reading("ended", 0), reading("ended", 0), [])).toEqual([]);
    // A count-in first read as 3.0x s (a "4", the device's clock a little
    // behind the server's) still beeps only at 3, 2 and 1.
    expect(matchCues(reading("not_started", 0), reading("countdown_autonomous", 4), [])).toEqual([BEEP]);
    expect(matchCues(reading("countdown_autonomous", 4), reading("countdown_autonomous", 3), [])).toEqual([]);
    expect(matchCues(reading("countdown_autonomous", 3), reading("countdown_autonomous", 2), [])).toEqual([BEEP]);
    // An early end freezes the clock where it stopped: a stopped clock still reads as ended.
    expect(matchCues(reading("driver", 41), reading("ended", 40, { endedEarly: true }), CUE_GAME)).toEqual([STOP]);
    expect(
      matchCues(reading("ended", 40, { endedEarly: true }), reading("ended", 40, { endedEarly: true }), CUE_GAME)
    ).toEqual([]);
  });

  it("dings and flashes amber when a window opens and again when it closes", () => {
    expect(matchCues(reading("driver", 36), reading("driver", 35), DRIVER_CHANGE)).toEqual([moment("Driver change")]);
    expect(matchCues(reading("driver", 35), reading("driver", 34), DRIVER_CHANGE)).toEqual([]);
    expect(matchCues(reading("driver", 26), reading("driver", 25), DRIVER_CHANGE)).toEqual([moment("Driver change")]);
    // Only in its own period.
    expect(matchCues(reading("autonomous", 36), reading("autonomous", 35), DRIVER_CHANGE)).toEqual([]);
  });

  it("fires an instant moment once", () => {
    expect(matchCues(reading("driver", 5), reading("driver", 4), CUE_GAME)).toEqual([moment("Endgame")]);
    expect(matchCues(reading("driver", 4), reading("driver", 3), CUE_GAME)).toEqual([BEEP]);
  });

  it("emits every crossing of a jump in descending order, moments before beeps", () => {
    expect(matchCues(reading("driver", 9), reading("driver", 2), CUE_GAME)).toEqual([
      moment("Driver change"),
      moment("Driver change"),
      moment("Endgame"),
      BEEP,
      BEEP,
    ]);
  });

  it("puts a moment before a beep at the same second", () => {
    const atThree: Moment[] = [{ key: "late", label: "Late", period: "driver", at_remaining: 3, until_remaining: null }];
    expect(matchCues(reading("driver", 4), reading("driver", 3), atThree)).toEqual([moment("Late"), BEEP]);
  });

  it("counts crossings from a count-in as crossing into the section", () => {
    const early: Moment[] = [
      { key: "open", label: "Open", period: "driver", at_remaining: 10, until_remaining: null },
    ];
    expect(matchCues(reading("countdown_driver", 1), reading("driver", 9), early)).toEqual([START, moment("Open")]);
    expect(matchCues(reading("countdown_driver", 1), reading("driver", 11), early)).toEqual([START]);
  });

  it("is silent while paused and across pause and resume", () => {
    expect(matchCues(reading("driver", 50), reading("driver", 50, { paused: true }), [])).toEqual([]);
    expect(matchCues(reading("driver", 50, { paused: true }), reading("driver", 50, { paused: true }), [])).toEqual([]);
    expect(matchCues(reading("driver", 50, { paused: true }), reading("driver", 50), [])).toEqual([]);
    expect(matchCues(reading("driver", 4), reading("driver", 3, { paused: true }), [])).toEqual([]);
    expect(
      matchCues(reading("countdown_driver", 3), reading("countdown_driver", 2, { paused: true }), [])
    ).toEqual([]);
  });

  it("treats a new match as starting from not started", () => {
    expect(
      matchCues(reading("ended", 0, { matchId: 1 }), reading("countdown_autonomous", 3, { matchId: 2 }), [])
    ).toEqual([BEEP]);
    expect(
      matchCues(reading("ended", 0, { matchId: 1 }), reading("countdown_driver", 2, { matchId: 2 }), [])
    ).toEqual([BEEP]);
    expect(matchCues(reading("driver", 40, { matchId: 1 }), reading("not_started", 0, { matchId: 2 }), [])).toEqual(
      []
    );
    expect(matchCues(reading("driver", 1, { matchId: 1 }), reading("ended", 0, { matchId: 2 }), [])).toEqual([]);
  });

  it("is silent for a new match first seen already inside a section (its count-in and start were missed)", () => {
    // Without this rule the first reading would burst a start, moments and beeps.
    expect(
      matchCues(reading("ended", 0, { matchId: 1 }), reading("driver", 2, { matchId: 2 }), CUE_GAME)
    ).toEqual([]);
    expect(
      matchCues(reading("ended", 0, { matchId: 1 }), reading("autonomous", 15, { matchId: 2 }), CUE_GAME)
    ).toEqual([]);
    // The next reading of that match cues as usual.
    expect(
      matchCues(reading("driver", 4, { matchId: 2 }), reading("driver", 3, { matchId: 2 }), [])
    ).toEqual([BEEP]);
  });
});

describe("holdMatchReading", () => {
  it("keeps the earlier, lower reading when the clock jitters up within a phase", () => {
    const held = reading("driver", 41);
    expect(holdMatchReading(held, reading("driver", 42))).toBe(held);
    expect(holdMatchReading(reading("countdown_driver", 2), reading("countdown_driver", 3))?.whole).toBe(2);
    // So the next real second is not a second crossing.
    expect(matchCues(holdMatchReading(held, reading("driver", 42)), reading("driver", 41), [])).toEqual([]);
  });

  it("takes the new reading when it counts down, or the match, phase or pause changes", () => {
    const next = reading("driver", 40);
    expect(holdMatchReading(reading("driver", 41), next)).toBe(next);
    const otherMatch = reading("driver", 50, { matchId: 2 });
    expect(holdMatchReading(reading("driver", 41), otherMatch)).toBe(otherMatch);
    const otherPhase = reading("driver", 105);
    expect(holdMatchReading(reading("countdown_driver", 1), otherPhase)).toBe(otherPhase);
    const paused = reading("driver", 42, { paused: true });
    expect(holdMatchReading(reading("driver", 41), paused)).toBe(paused);
    const resumed = reading("driver", 42);
    expect(holdMatchReading(reading("driver", 41, { paused: true }), resumed)).toBe(resumed);
    expect(holdMatchReading(null, next)).toBe(next);
    expect(holdMatchReading(next, null)).toBeNull();
  });
});

describe("skillsCues", () => {
  it("is silent on the first reading", () => {
    expect(skillsCues(null, skills("running", 50))).toEqual([]);
    expect(skillsCues(skills("running", 50), null)).toEqual([]);
  });

  it("plays the start sound when a run starts", () => {
    expect(skillsCues(skills("ready", 60), skills("running", 60))).toEqual([START]);
  });

  it("beeps at 3, 2 and 1", () => {
    expect(skillsCues(skills("running", 4), skills("running", 3))).toEqual([BEEP]);
    expect(skillsCues(skills("running", 3), skills("running", 2))).toEqual([BEEP]);
    expect(skillsCues(skills("running", 2), skills("running", 1))).toEqual([BEEP]);
    expect(skillsCues(skills("running", 31), skills("running", 30))).toEqual([]);
    expect(skillsCues(skills("running", 5), skills("running", 1))).toEqual([BEEP, BEEP, BEEP]);
  });

  it("sounds the buzzer when a run runs out, the power-down when it is ended early", () => {
    expect(skillsCues(skills("running", 1), skills("ended", 0))).toEqual([OVER]);
    expect(skillsCues(skills("running", 0), skills("ended", 0, { endedEarly: false }))).toEqual([OVER]);
    expect(skillsCues(skills("running", 40), skills("ended", 0, { endedEarly: true }))).toEqual([STOP]);
    expect(skillsCues(skills("running", 0), skills("ended", 0, { endedEarly: true }))).toEqual([STOP]);
    expect(skillsCues(skills("running", 40, { paused: true }), skills("ended", 0, { endedEarly: true }))).toEqual([
      STOP,
    ]);
  });

  it("stops on a reset of a running or paused run", () => {
    expect(skillsCues(skills("running", 40), skills("ready", 60))).toEqual([STOP]);
    expect(skillsCues(skills("running", 40, { paused: true }), skills("ready", 60))).toEqual([STOP]);
  });

  it("is silent resetting a finished timer for the next team", () => {
    expect(skillsCues(skills("ended", 0), skills("ready", 60))).toEqual([]);
    expect(skillsCues(skills("ended", 0, { endedEarly: true }), skills("ready", 60))).toEqual([]);
    expect(skillsCues(skills("ended", 23, { endedEarly: true }), skills("ended", 23, { endedEarly: true }))).toEqual([]);
    expect(skillsCues(skills("ready", 60), skills("ready", 60))).toEqual([]);
  });

  it("is silent while paused and across pause and resume", () => {
    expect(skillsCues(skills("running", 40), skills("running", 40, { paused: true }))).toEqual([]);
    expect(skillsCues(skills("running", 40, { paused: true }), skills("running", 40))).toEqual([]);
    expect(skillsCues(skills("running", 4), skills("running", 3, { paused: true }))).toEqual([]);
  });

  it("treats a changed timer as ready, so a first reading already ended is silent", () => {
    expect(skillsCues(skills("running", 1, { timerKey: "a" }), skills("ended", 0, { timerKey: "b" }))).toEqual([]);
  });

  it("reads a running timer that jumps up more than a second as a reset and restart", () => {
    expect(skillsCues(skills("running", 40), skills("running", 60))).toEqual([STOP, START]);
    expect(skillsCues(skills("running", 40, { paused: true }), skills("running", 60))).toEqual([STOP, START]);
    expect(skillsCues(skills("running", 40), skills("running", 42))).toEqual([STOP, START]);
    // A rise of one second is clock jitter, never a restart.
    expect(skillsCues(skills("running", 40), skills("running", 41))).toEqual([]);
    expect(skillsCues(skills("running", 40), skills("running", 60, { paused: true }))).toEqual([]);
  });

  it("is silent for a changed timer first seen already running (its start was missed)", () => {
    expect(skillsCues(skills("ended", 0, { timerKey: "a" }), skills("running", 60, { timerKey: "b" }))).toEqual([]);
    expect(skillsCues(skills("ready", 60, { timerKey: "a" }), skills("running", 2, { timerKey: "b" }))).toEqual([]);
    // A changed timer first seen ready starts normally afterwards.
    expect(skillsCues(skills("ready", 60, { timerKey: "b" }), skills("running", 60, { timerKey: "b" }))).toEqual([
      START,
    ]);
  });
});

describe("holdSkillsReading", () => {
  it("keeps the earlier, lower reading when a running timer jitters up", () => {
    const held = skills("running", 4);
    expect(holdSkillsReading(held, skills("running", 5))).toBe(held);
    expect(skillsCues(holdSkillsReading(held, skills("running", 5)), skills("running", 4))).toEqual([]);
  });

  it("does not hold a rise of more than a second, so a restart cues", () => {
    const restarted = skills("running", 60);
    expect(holdSkillsReading(skills("running", 40), restarted)).toBe(restarted);
    expect(holdSkillsReading(skills("running", 4), skills("running", 6))?.whole).toBe(6);
  });

  it("takes the new reading otherwise", () => {
    const down = skills("running", 3);
    expect(holdSkillsReading(skills("running", 4), down)).toBe(down);
    const other = skills("running", 50, { timerKey: "b" });
    expect(holdSkillsReading(skills("running", 4), other)).toBe(other);
    const ready = skills("ready", 60);
    expect(holdSkillsReading(skills("ready", 30), ready)).toBe(ready);
    const paused = skills("running", 5, { paused: true });
    expect(holdSkillsReading(skills("running", 4), paused)).toBe(paused);
    expect(holdSkillsReading(null, down)).toBe(down);
    expect(holdSkillsReading(down, null)).toBeNull();
  });
});

describe("timeoutCues", () => {
  it("dings when a time-out runs out, not when it is cancelled", () => {
    expect(timeoutCues(0.5, 0)).toEqual([{ sound: "moment", flash: null }]);
    expect(timeoutCues(0.5, -0.2)).toEqual([{ sound: "moment", flash: null }]);
    expect(timeoutCues(0.5, null)).toEqual([]);
    expect(timeoutCues(null, 10)).toEqual([]);
    expect(timeoutCues(0, -1)).toEqual([]);
  });
});

describe("activeWindow", () => {
  it("is the window while until < remaining <= at in its period", () => {
    expect(activeWindow("driver", 35, DRIVER_CHANGE)).toEqual(DRIVER_CHANGE[0]);
    expect(activeWindow("driver", 30, DRIVER_CHANGE)).toEqual(DRIVER_CHANGE[0]);
    expect(activeWindow("driver", 25.01, DRIVER_CHANGE)).toEqual(DRIVER_CHANGE[0]);
    expect(activeWindow("driver", 25, DRIVER_CHANGE)).toBeNull();
    expect(activeWindow("driver", 35.5, DRIVER_CHANGE)).toBeNull();
    expect(activeWindow("autonomous", 30, DRIVER_CHANGE)).toBeNull();
    expect(activeWindow("countdown_driver", 30, DRIVER_CHANGE)).toBeNull();
  });

  it("is null for instant moments and with no moments", () => {
    expect(activeWindow("driver", 4, CUE_GAME)).toBeNull();
    expect(activeWindow("driver", 3.5, CUE_GAME)).toBeNull();
    expect(activeWindow("driver", 7, CUE_GAME)).toEqual(CUE_GAME[0]);
    expect(activeWindow("driver", 30, [])).toBeNull();
  });
});
