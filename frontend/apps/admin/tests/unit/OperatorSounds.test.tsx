import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, type LiveMatch } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { OperatorSounds, type OperatorStream } from "../../src/cues/OperatorSounds";
import { useOperatorSoundSetting } from "../../src/cues/useOperatorSoundSetting";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});
import { apiRequest } from "@tournament-admin/shared";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const SLOTS = ["beep", "start", "buzzer", "moment", "stop"] as const;
const contexts: FakeContext[] = [];

class FakeContext {
  constructor() {
    contexts.push(this);
  }
  state = "running";
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

function match(overrides: Partial<LiveMatch>): LiveMatch {
  return {
    id: 1, session_id: 1, label: "Q1", field_id: 1, phase: "not_started", phase_deadline: null, paused: false,
    remaining_seconds: null, status: "scheduled", is_finals: false, ended_early: false, ...overrides,
  } as unknown as LiveMatch;
}
const matchStream = (matches: LiveMatch[], extra: Partial<Extract<OperatorStream, { kind: "match" }>> = {}): OperatorStream => ({
  kind: "match", key: "fieldSet:10", matches, fieldIds: [1], timeoutDeadline: null, ...extra,
});
const skillsStream = (timer: Record<string, unknown>): OperatorStream => ({
  kind: "skills", key: "set:20",
  timer: { phase: "ready", deadline: null, paused: false, remaining_seconds: null, ended_early: false, ...timer } as never,
});

function Harness({ page, streams }: { page: "matchControl" | "skillsControl"; streams: OperatorStream[] }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <OperatorSounds page={page} streams={streams} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const i18n = initI18n({ en: { translation: enAdmin } });
const SWITCH = "Play sounds on this computer";

beforeEach(() => {
  contexts.length = 0;
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const slot = /sounds\/(\w+)\/audio/.exec(url)![1];
      return new Response(JSON.stringify(slot));
    })
  );
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/sounds") return SLOTS.map((slot) => ({ slot, replaced: false, filename: null, uploaded_at: null })) as never;
    if (path === "/api/event/match-format") return { moments: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function turnOn(page: "matchControl" | "skillsControl", streams: OperatorStream[]) {
  const view = render(<Harness page={page} streams={streams} />);
  fireEvent.click(screen.getByLabelText(SWITCH));
  await tick(500);
  return view;
}

describe("Operator sounds", () => {
  it("is off by default and persists once turned on", async () => {
    const first = render(<Harness page="matchControl" streams={[]} />);
    expect(screen.getByLabelText(SWITCH)).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(SWITCH));
    expect(localStorage.getItem("tm.operatorSounds.matchControl")).toBe("1");
    first.unmount();
    render(<Harness page="matchControl" streams={[]} />);
    expect(screen.getByLabelText(SWITCH)).toBeChecked();
  });

  it("keeps a separate setting for each page", () => {
    localStorage.setItem("tm.operatorSounds.skillsControl", "1");
    render(<Harness page="matchControl" streams={[]} />);
    expect(screen.getByLabelText(SWITCH)).not.toBeChecked();
  });

  it("plays start when the match goes from its count-in to autonomous", async () => {
    const view = await turnOn("matchControl", [matchStream([match({ phase: "countdown_autonomous", phase_deadline: iso(2_500) })])]);
    expect(played()).not.toContain("start");
    await tick(300);
    view.rerender(<Harness page="matchControl" streams={[matchStream([match({ phase: "autonomous", phase_deadline: iso(15_000) })])]} />);
    await tick(300);
    expect(played()).toContain("start");
  });

  it("plays stop when the operator ends the match early", async () => {
    const view = await turnOn("matchControl", [matchStream([match({ phase: "driver", phase_deadline: iso(30_000) })])]);
    await tick(300);
    view.rerender(<Harness page="matchControl" streams={[matchStream([match({ phase: "ended", ended_early: true })])]} />);
    await tick(300);
    expect(played()).toContain("stop");
  });

  it("plays the buzzer when a skills set timer runs out", async () => {
    const view = await turnOn("skillsControl", [skillsStream({ phase: "running", deadline: iso(1_000) })]);
    await tick(300);
    expect(played()).not.toContain("buzzer");
    await tick(1_500);
    view.rerender(<Harness page="skillsControl" streams={[skillsStream({ phase: "running", deadline: iso(-500) })]} />);
    await tick(300);
    expect(played()).toContain("buzzer");
  });

  it("plays nothing while the switch is off", async () => {
    const view = render(<Harness page="matchControl" streams={[matchStream([match({ phase: "countdown_autonomous", phase_deadline: iso(2_500) })])]} />);
    await tick(300);
    view.rerender(<Harness page="matchControl" streams={[matchStream([match({ phase: "autonomous", phase_deadline: iso(15_000) })])]} />);
    await tick(500);
    expect(played()).toEqual([]);
    expect(contexts).toHaveLength(0);
  });

  it("asks for a click when the browser blocks sound", async () => {
    vi.stubGlobal("AudioContext", class extends FakeContext { state = "suspended"; });
    await turnOn("matchControl", []);
    fireEvent.click(await screen.findByRole("button", { name: "Click to enable sound" }));
    await tick(100);
    expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument();
  });

  it("still renders when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Harness page="matchControl" streams={[]} />);
    expect(screen.getByLabelText(SWITCH)).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(SWITCH));
    expect(screen.getByLabelText(SWITCH)).toBeChecked();
  });
});

describe("useOperatorSoundSetting", () => {
  it("is exported", () => {
    expect(typeof useOperatorSoundSetting).toBe("function");
  });
});
