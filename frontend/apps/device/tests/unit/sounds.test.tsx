import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import { matchCues, timeoutCues, type ClockState } from "../../src/display/logic/sounds";
import { SoundPlayer } from "../../src/display/soundPlayer";
import { audienceGroup, baseRoutes, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const state = (phase: string, whole: number, extra: Partial<ClockState> = {}): ClockState => ({
  matchId: 1, phase, whole, paused: false, ...extra,
});

describe("matchCues", () => {
  it("is silent on the first reading and while paused", () => {
    expect(matchCues(null, state("driver", 50))).toEqual([]);
    expect(matchCues(state("driver", 50), state("driver", 30, { paused: true }))).toEqual([]);
  });

  it("beats on each count-in second, then starts the period", () => {
    expect(matchCues(state("not_started", 0), state("countdown_autonomous", 3))).toEqual(["beat"]);
    expect(matchCues(state("countdown_autonomous", 3), state("countdown_autonomous", 2))).toEqual(["beat"]);
    expect(matchCues(state("countdown_autonomous", 1), state("autonomous", 15))).toEqual(["start"]);
  });

  it("warns at 30 seconds, ends periods and the match", () => {
    expect(matchCues(state("driver", 31), state("driver", 30))).toEqual(["warning"]);
    expect(matchCues(state("driver", 30), state("driver", 29))).toEqual([]);
    expect(matchCues(state("autonomous", 1), state("awaiting_driver", 0))).toEqual(["periodEnd"]);
    expect(matchCues(state("driver", 1), state("ended", 0))).toEqual(["matchEnd"]);
  });

  it("treats a new match as starting from not started", () => {
    expect(matchCues(state("ended", 0, { matchId: 1 }), state("countdown_driver", 3, { matchId: 2 }))).toEqual(["beat"]);
  });
});

describe("timeoutCues", () => {
  it("sounds when a time-out runs out, not when it is cancelled", () => {
    expect(timeoutCues(0.5, 0)).toEqual(["timeoutEnd"]);
    expect(timeoutCues(0.5, null)).toEqual([]);
    expect(timeoutCues(null, 10)).toEqual([]);
  });
});

const contexts: FakeContext[] = [];

class FakeContext {
  constructor() {
    contexts.push(this);
  }
  close = vi.fn(async () => {});
  state = "suspended";
  currentTime = 0;
  destination = {};
  started: number[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createOscillator() {
    return { frequency: { value: 0 }, connect: vi.fn(), start: (at: number) => this.started.push(at), stop: vi.fn() };
  }
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn() };
  }
}

describe("SoundPlayer", () => {
  it("is blocked until unlocked, and plays only when running", async () => {
    const context = new FakeContext();
    const player = new SoundPlayer(() => context as unknown as AudioContext);
    expect(player.blocked).toBe(true);
    player.play("start");
    expect(context.started).toEqual([]);
    await player.unlock();
    expect(player.blocked).toBe(false);
    player.play("warning");
    expect(context.started).toHaveLength(2);
  });
});

describe("audience sounds", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for a click when the browser blocks sound, and only when sounds are on", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const now = Date.now();
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "logo", play_sounds: true })),
      "/api/matches?session_id=1": [match({ phase: "driver", phase_deadline: new Date(now + 40_000).toISOString() })],
    });
    renderDisplay();
    const note = await screen.findByRole("button", { name: "Click to enable sound" });
    fireEvent.click(note);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument();
  });

  it("closes its audio context when the display unmounts", async () => {
    contexts.length = 0;
    vi.stubGlobal("AudioContext", FakeContext);
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "logo", play_sounds: true })) });
    const { unmount } = renderDisplay();
    await screen.findByRole("button", { name: "Click to enable sound" });
    expect(contexts).toHaveLength(1);
    unmount();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("shows no note when sounds are off", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "logo", play_sounds: false })) });
    renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument();
  });
});
