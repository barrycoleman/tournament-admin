import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import { SoundPlayer } from "../../src/display/soundPlayer";
import { audienceGroup, baseRoutes, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

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
    player.play("moment");
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
