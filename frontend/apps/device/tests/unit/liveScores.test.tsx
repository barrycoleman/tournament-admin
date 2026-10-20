import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, audienceGroup, baseRoutes, fieldGroup, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";
import { applyLiveScore, type LiveScores } from "../../src/display/useLiveScores";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const EMPTY: LiveScores = { matches: [], skills: [] };
const TOTALS = { match_id: 5, alliances: [{ alliance_id: 51, score: 12 }, { alliance_id: 52, score: 7 }] };

let matches: unknown[];
let live: LiveScores;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  matches = [match({ id: 5, label: "Q5", match_number: 5, phase: "driver", phase_deadline: iso(30_000) })];
  live = EMPTY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(group: Record<string, unknown> = audienceGroup({ screen: "in_match" }), extra: Record<string, unknown> = {}) {
  serveDisplay({
    ...baseRoutes(),
    "/api/displays/me": me(group),
    "/api/matches?session_id=1": () => matches,
    "/api/displays/live-scores?field_set_id=10": () => live,
    ...extra,
  });
  return renderDisplay();
}

describe("live totals on In Match", () => {
  it("shows each alliance's live total with a Live tag", async () => {
    live = { matches: [TOTALS], skills: [] };
    show();
    expect(await screen.findByTestId("live-red")).toHaveTextContent("12");
    expect(screen.getByTestId("live-red")).toHaveTextContent("Live");
    expect(screen.getByTestId("live-blue")).toHaveTextContent("7");
  });

  it("follows live_score events and drops the totals when they are cleared", async () => {
    const { emit } = show();
    await screen.findByTestId("clock");
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
    live = { matches: [TOTALS], skills: [] };
    emit("live_score", TOTALS);
    expect(await screen.findByTestId("live-red")).toHaveTextContent("12");
    live = EMPTY;
    emit("live_score", { match_id: 5, cleared: true });
    await waitFor(() => expect(screen.queryByTestId("live-red")).not.toBeInTheDocument());
  });

  it("hides the totals once the match has ended, before any clear arrives", async () => {
    matches = [match({ id: 5, label: "Q5", match_number: 5, phase: "ended" })];
    live = { matches: [TOTALS], skills: [] };
    show();
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
  });

  it("ignores a stray live_score that arrives after the match ended", async () => {
    matches = [match({ id: 5, label: "Q5", match_number: 5, phase: "ended" })];
    const { emit } = show();
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    emit("live_score", TOTALS);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-blue")).not.toBeInTheDocument();
  });

  it("shows no totals on the next-match view of a match that has not started", async () => {
    matches = [match({ id: 5, label: "Q5", match_number: 5, phase: "not_started" })];
    live = { matches: [TOTALS], skills: [] };
    show(fieldGroup(), { "/api/displays/live-scores?field_set_id=10": () => live });
    await screen.findByTestId("bar-red");
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
  });

  it("shows one total for a cooperative game", async () => {
    live = { matches: [{ match_id: 5, alliances: [{ alliance_id: 51, score: 15 }, { alliance_id: 52, score: 15 }] }], skills: [] };
    show(audienceGroup({ screen: "in_match" }), { "/api/event/match-format": COOPERATIVE });
    expect(await screen.findByTestId("live-all")).toHaveTextContent("15");
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
  });

  it("shows the totals on the field display too", async () => {
    live = { matches: [TOTALS], skills: [] };
    show(fieldGroup());
    expect(await screen.findByTestId("live-blue")).toHaveTextContent("7");
  });
});

describe("applyLiveScore", () => {
  it("replaces a match's totals and removes them when cleared", () => {
    const first = applyLiveScore(EMPTY, TOTALS);
    expect(first.matches).toEqual([TOTALS]);
    const updated = applyLiveScore(first, { match_id: 5, alliances: [{ alliance_id: 51, score: 14 }] });
    expect(updated.matches).toEqual([{ match_id: 5, alliances: [{ alliance_id: 51, score: 14 }] }]);
    expect(applyLiveScore(updated, { match_id: 5, cleared: true }).matches).toEqual([]);
  });

  it("keeps a skills field's score and breakdown, and removes them when cleared", () => {
    const running = applyLiveScore(EMPTY, { field_id: 31, score: 9 });
    expect(running.skills).toEqual([{ field_id: 31, score: 9, breakdown: null }]);
    const ended = applyLiveScore(running, { field_id: 31, score: 9, breakdown: [{ label: "Score", value: 9 }] });
    expect(ended.skills).toEqual([{ field_id: 31, score: 9, breakdown: [{ label: "Score", value: 9 }] }]);
    expect(applyLiveScore(ended, { field_id: 31, cleared: true }).skills).toEqual([]);
  });

  it("ignores anything else", () => {
    expect(applyLiveScore(EMPTY, { something: 1 })).toBe(EMPTY);
    expect(applyLiveScore(EMPTY, null)).toBe(EMPTY);
  });
});
