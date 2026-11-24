import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { holdMatchReading, matchCues, useCueTrigger, useHeldReading, useTimerCues, type Cue, type MatchReading } from "../src";

const reading = (phase: string, whole: number, extra: Partial<MatchReading> = {}): MatchReading => ({
  matchId: 1,
  phase,
  whole,
  paused: false,
  endedEarly: false,
  ...extra,
});
const compute = (prev: MatchReading | null, next: MatchReading | null) => matchCues(prev, next, []);
const BEEP: Cue = { sound: "beep", flash: null };
const START: Cue = { sound: "start", flash: null };

describe("useCueTrigger", () => {
  it("never cues on the first reading, then cues each change", () => {
    const onCues = vi.fn();
    const { rerender } = renderHook(({ r }) => useCueTrigger(r, compute, onCues), {
      initialProps: { r: reading("driver", 2) as MatchReading | null },
    });
    expect(onCues).not.toHaveBeenCalled();
    rerender({ r: reading("driver", 1) });
    expect(onCues).toHaveBeenCalledWith([BEEP]);
  });

  it("does not call back with no cues", () => {
    const onCues = vi.fn();
    const { rerender } = renderHook(({ r }) => useCueTrigger(r, compute, onCues), {
      initialProps: { r: reading("driver", 50) },
    });
    rerender({ r: reading("driver", 49) });
    rerender({ r: reading("driver", 49) });
    expect(onCues).not.toHaveBeenCalled();
  });

  it("treats the reading after a gap (no reading) as a first reading", () => {
    const onCues = vi.fn();
    const { rerender } = renderHook(({ r }) => useCueTrigger(r, compute, onCues), {
      initialProps: { r: reading("countdown_autonomous", 1) as MatchReading | null },
    });
    rerender({ r: null });
    rerender({ r: reading("autonomous", 15) });
    expect(onCues).not.toHaveBeenCalled();
    rerender({ r: reading("countdown_autonomous", 1, { matchId: 2 }) });
    rerender({ r: reading("autonomous", 15, { matchId: 2 }) });
    expect(onCues).toHaveBeenCalledWith([START]);
  });
});

describe("useHeldReading with the cue trigger", () => {
  it("plays each crossing once when the clock jitters back up across it", () => {
    const onCues = vi.fn();
    const { rerender } = renderHook(
      ({ r }) => {
        const held = useHeldReading(r, holdMatchReading);
        useCueTrigger(held, compute, onCues);
      },
      { initialProps: { r: reading("driver", 4) } }
    );
    rerender({ r: reading("driver", 3) });
    expect(onCues).toHaveBeenCalledTimes(1);
    // A re-measured clock offset puts the clock back over 3 s, then down again.
    rerender({ r: reading("driver", 4) });
    rerender({ r: reading("driver", 3) });
    expect(onCues).toHaveBeenCalledTimes(1);
    rerender({ r: reading("driver", 2) });
    expect(onCues).toHaveBeenCalledTimes(2);
    expect(onCues).toHaveBeenLastCalledWith([BEEP]);
  });
});

describe("useTimerCues and the first match of the day", () => {
  const run = (matchLoaded: boolean | undefined) => {
    const onCues = vi.fn();
    const props = (match: MatchReading | null) => ({ match });
    const { rerender } = renderHook(
      ({ match }) =>
        useTimerCues({ key: "fieldSet:1", match, matchLoaded, skills: null, timeout: null, moments: [] }, onCues),
      { initialProps: props(null) }
    );
    rerender(props(null));
    rerender(props(reading("countdown_autonomous", 3)));
    rerender(props(reading("countdown_autonomous", 2)));
    return onCues;
  };

  it("beeps the first count-in second when no match had started on the loaded fields", () => {
    const onCues = run(true);
    expect(onCues.mock.calls).toEqual([[[BEEP]], [[BEEP]]]);
  });

  it("treats the first match reading as a first reading while the matches are still loading", () => {
    const onCues = run(false);
    expect(onCues.mock.calls).toEqual([[[BEEP]]]);
  });

  it("stays silent for a match first seen inside a section, loaded or not", () => {
    const onCues = vi.fn();
    const { rerender } = renderHook(
      ({ match }) => useTimerCues({ key: "k", match, matchLoaded: true, skills: null, timeout: null, moments: [] }, onCues),
      { initialProps: { match: null as MatchReading | null } }
    );
    rerender({ match: reading("autonomous", 12) });
    rerender({ match: reading("autonomous", 12) });
    expect(onCues).not.toHaveBeenCalled();
  });
});
