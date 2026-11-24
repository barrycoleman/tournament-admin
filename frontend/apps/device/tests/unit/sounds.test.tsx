import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import { FIELDS, FIELD_SETS, audienceGroup, baseRoutes, fieldGroup, match, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const SLOTS = ["beep", "start", "buzzer", "moment", "stop"] as const;

const contexts: FakeContext[] = [];

/** A stand-in AudioContext: "decodes" a slot's audio route (which answers
 * with the slot's name and version) and records each sound it starts. */
class FakeContext {
  constructor() {
    contexts.push(this);
  }
  state = "suspended";
  currentTime = 0;
  destination = {};
  played: string[] = [];
  close = vi.fn(async () => {});
  resume = vi.fn(async () => {
    this.state = "running";
  });
  decodeAudioData = vi.fn(async (data: ArrayBuffer) => JSON.parse(new TextDecoder().decode(data)) as string);
  createBufferSource() {
    const source = {
      buffer: null as string | null,
      connect: vi.fn(),
      start: () => this.played.push(String(source.buffer)),
      stop: vi.fn(),
    };
    return source;
  }
}

const played = () => contexts.flatMap((c) => c.played);

function soundRoutes(version = "v1") {
  return Object.fromEntries(SLOTS.map((slot) => [`/api/sounds/${slot}/audio`, `${slot}:${version}`]));
}
const SOUND_LIST = SLOTS.map((slot) => ({ slot, replaced: false, filename: null, uploaded_at: null }));

const tvMe = (group: Record<string, unknown>, playSounds = true) => ({
  ...me(group),
  device: { id: 7, name: "Big TV", play_sounds: playSounds },
});

beforeEach(() => {
  contexts.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function enableSound() {
  fireEvent.click(await screen.findByRole("button", { name: "Click to enable sound" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument());
}

/** Lets the readings tick (every 0.1 s) for `ms`. */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("TV sounds", () => {
  it("plays the start sound when a followed match goes from its count-in to autonomous", async () => {
    let matches = [match({ id: 1, phase: "countdown_autonomous", phase_deadline: iso(2_500) })];
    serveDisplay({
      ...baseRoutes(),
      ...soundRoutes(),
      "/api/sounds": SOUND_LIST,
      "/api/displays/me": tvMe(audienceGroup({ screen: "logo" })),
      "/api/matches?session_id=1": () => matches,
    });
    const { emit } = renderDisplay();
    await enableSound();
    await tick(300);
    matches = [match({ id: 1, phase: "autonomous", phase_deadline: iso(15_000) })];
    emit("match_phase_changed", { match_id: 1 });
    await tick(300);
    await waitFor(() => expect(played()).toContain("start:v1"));
  });

  it("plays the power-down, not the buzzer, when a field TV's match is ended early", async () => {
    let matches = [match({ id: 1, field_id: 1, phase: "driver", phase_deadline: iso(40_000) })];
    serveDisplay({
      ...baseRoutes(),
      ...soundRoutes(),
      "/api/sounds": SOUND_LIST,
      "/api/displays/me": tvMe(fieldGroup()),
      "/api/matches?session_id=1": () => matches,
    });
    const { emit } = renderDisplay();
    await enableSound();
    await tick(300);
    matches = [match({ id: 1, field_id: 1, phase: "ended", phase_deadline: null, ended_early: true })];
    emit("match_phase_changed", { match_id: 1 });
    await waitFor(() => expect(played()).toContain("stop:v1"));
    expect(played()).not.toContain("buzzer:v1");
  });

  it("plays the power-down when a live match is reset to not started", async () => {
    let matches = [match({ id: 1, field_id: 1, phase: "driver", phase_deadline: iso(40_000) })];
    serveDisplay({
      ...baseRoutes(),
      ...soundRoutes(),
      "/api/sounds": SOUND_LIST,
      "/api/displays/me": tvMe(audienceGroup({ screen: "in_match" })),
      "/api/matches?session_id=1": () => matches,
    });
    const { emit } = renderDisplay();
    await enableSound();
    await tick(300);
    matches = [match({ id: 1, field_id: 1, phase: "not_started", phase_deadline: null })];
    emit("match_reset", { match_id: 1 });
    await tick(300);
    await waitFor(() => expect(played()).toContain("stop:v1"));
    expect(played()).not.toContain("buzzer:v1");
  });

  it("dings on a field TV when its field set's time-out runs out", async () => {
    serveDisplay({
      ...baseRoutes(),
      ...soundRoutes(),
      "/api/sounds": SOUND_LIST,
      "/api/displays/me": tvMe(fieldGroup({ field_set: { queued_match_id: null, timeout_deadline: iso(1_500) } })),
    });
    renderDisplay();
    await enableSound();
    expect(played()).not.toContain("moment:v1");
    await tick(2_000);
    await waitFor(() => expect(played()).toContain("moment:v1"));
  });

  it("plays the buzzer when a skills set's timer runs out", async () => {
    const skillsSet = { id: 20, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };
    const timer = {
      field_set_id: 20, skills_type: "autonomous", phase: "running", deadline: iso(1_500), paused: false,
      remaining_seconds: null, run_seconds: 60, ended_early: false,
    };
    serveDisplay({
      ...baseRoutes(),
      ...soundRoutes(),
      "/api/sounds": SOUND_LIST,
      "/api/displays/me": tvMe(audienceGroup({ name: "Skills Row", field_set_id: 20 })),
      "/api/field-sets?session_id=1": [...FIELD_SETS, skillsSet],
      "/api/fields?session_id=1": [...FIELDS, { id: 31, field_set_id: 20, name: "Skills 1" }],
      "/api/skills/settings": { enabled: true, attempts: {}, types: [{ key: "autonomous", label: "Autonomous", run_seconds: 60 }] },
      "/api/field-sets/20/skills": { timer, fields: [] },
    });
    renderDisplay();
    await enableSound();
    await tick(2_000);
    await waitFor(() => expect(played()).toContain("buzzer:v1"));
  });

  it("mounts no player on a TV whose sound is off", async () => {
    serveDisplay({ ...baseRoutes(), ...soundRoutes(), "/api/displays/me": tvMe(audienceGroup({ screen: "logo" }), false) });
    renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    await tick(200);
    expect(contexts).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument();
  });

  it("never mounts a player on a pit TV, even with its sound on", async () => {
    serveDisplay({ ...baseRoutes(), ...soundRoutes(), "/api/displays/me": tvMe(pitGroup()) });
    renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    await tick(200);
    expect(contexts).toHaveLength(0);
  });

  it("asks for a click while the browser blocks sound, and preloads every slot", async () => {
    const fetchSpy = serveDisplay({
      ...baseRoutes(),
      ...soundRoutes(),
      "/api/sounds": SOUND_LIST,
      "/api/displays/me": tvMe(audienceGroup({ screen: "logo" })),
    });
    renderDisplay();
    expect(await screen.findByRole("button", { name: "Click to enable sound" })).toBeInTheDocument();
    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map(([input]) => String(input));
      for (const slot of SLOTS) expect(urls).toContain(`/api/sounds/${slot}/audio`);
    });
    await enableSound();
  });

  it("reloads a slot's sound when sounds_changed says it changed", async () => {
    let list = SOUND_LIST;
    let routes = soundRoutes("v1");
    const matches = [match({ id: 1, phase: "driver", phase_deadline: iso(8_000) })];
    const fetchSpy = serveDisplay({
      ...baseRoutes(),
      ...Object.fromEntries(SLOTS.map((slot) => [`/api/sounds/${slot}/audio`, () => routes[`/api/sounds/${slot}/audio`]])),
      "/api/sounds": () => list,
      "/api/displays/me": tvMe(audienceGroup({ screen: "logo" })),
      "/api/matches?session_id=1": () => matches,
    });
    const { emit } = renderDisplay();
    await enableSound();
    const beepFetches = () => fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/sounds/beep/audio").length;
    await waitFor(() => expect(beepFetches()).toBe(1));
    routes = soundRoutes("v2");
    list = SOUND_LIST.map((row) =>
      row.slot === "beep" ? { ...row, replaced: true, filename: "beep.mp3", uploaded_at: "2026-11-07T15:59:00Z" } : row
    ) as typeof SOUND_LIST;
    emit("sounds_changed", { slot: "beep" });
    await waitFor(() => expect(beepFetches()).toBe(2));
    expect(fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/sounds/start/audio")).toHaveLength(1);
    // The last three seconds beep with the new sound.
    await tick(6_000);
    await waitFor(() => expect(played()).toContain("beep:v2"));
    expect(played()).not.toContain("beep:v1");
  });

  it("closes its audio context when the display unmounts", async () => {
    serveDisplay({ ...baseRoutes(), ...soundRoutes(), "/api/sounds": SOUND_LIST, "/api/displays/me": tvMe(audienceGroup({ screen: "logo" })) });
    const { unmount } = renderDisplay();
    await screen.findByRole("button", { name: "Click to enable sound" });
    unmount();
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) expect(context.close).toHaveBeenCalled();
  });
});
