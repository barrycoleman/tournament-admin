import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, audienceGroup, baseRoutes, fieldGroup, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function showField(
  matches: unknown[],
  { group = fieldGroup(), offset = 0, extra = {} }: { group?: Record<string, unknown>; offset?: number; extra?: Record<string, unknown> } = {}
) {
  serveDisplay(
    { ...baseRoutes(), "/api/displays/me": me(group), "/api/matches?session_id=1": matches, ...extra },
    { serverOffsetMs: offset }
  );
  return renderDisplay();
}

describe("field display", () => {
  it("shows the field's next match with its team numbers in alliance bars", async () => {
    showField([match({ id: 7, label: "Q7", match_number: 7, scheduled_time: iso(83_000) })]);
    expect(await screen.findByRole("heading", { name: "Qualification 7" })).toBeInTheDocument();
    expect(screen.getByText("Field 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("bar-red")).getByText("101A")).toBeInTheDocument();
    expect(within(screen.getByTestId("bar-blue")).getByText("104D")).toBeInTheDocument();
    const start = screen.getByTestId("start");
    expect(start).toHaveTextContent("1:23 to go");
    expect(start).toHaveAttribute("data-band", "early");
  });

  it("turns yellow at 30 seconds and red once late", async () => {
    showField([match({ scheduled_time: iso(31_000) })]);
    const start = await screen.findByTestId("start");
    expect(start).toHaveAttribute("data-band", "early");
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "soon");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "late");
    expect(screen.getByTestId("start")).toHaveTextContent("0:00 late");
  });

  it("uses the server's clock, not the TV's", async () => {
    // The server is a minute ahead: 80 s away on the TV's clock is 20 s away for real.
    showField([match({ scheduled_time: iso(80_000) })], { offset: 60_000 });
    await screen.findByTestId("start");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "soon");
  });

  it("shows Up next for a match with no scheduled time, and one bar for a cooperative game", async () => {
    showField([match({ scheduled_time: null })], { extra: { "/api/event/match-format": COOPERATIVE } });
    expect(await screen.findByTestId("start")).toHaveTextContent("Up next");
    expect(screen.getByTestId("bar-all")).toHaveTextContent("101A");
    expect(screen.getByTestId("bar-all")).toHaveTextContent("104D");
    expect(screen.queryByTestId("bar-red")).not.toBeInTheDocument();
  });

  it("counts in with 3-2-1 under the period's name", async () => {
    showField([match({ phase: "countdown_autonomous", phase_deadline: iso(2_500) })]);
    expect(await screen.findByTestId("count-in")).toHaveTextContent("3");
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByTestId("count-in")).toHaveTextContent("2");
  });

  it("shows the period clock, a paused banner and Driver control next", async () => {
    let matches = [match({ id: 3, phase: "driver", phase_deadline: iso(95_000) })];
    const { emit } = showField([], { extra: { "/api/matches?session_id=1": () => matches } });
    expect(await screen.findByTestId("clock")).toHaveTextContent("1:35");
    expect(screen.getByText("Driver control")).toBeInTheDocument();
    matches = [match({ id: 3, phase: "driver", paused: true, remaining_seconds_at_pause: 40 })];
    emit("match_paused", { match_id: 3 });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:40");
    matches = [match({ id: 3, phase: "awaiting_driver" })];
    emit("match_phase_changed", { match_id: 3 });
    expect(await screen.findByText("Driver control next")).toBeInTheDocument();
    matches = [match({ id: 3, phase: "ended" })];
    emit("match_phase_changed", { match_id: 3 });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
  });

  it("moves to the field's next match once the score is saved, and says when the field is done", async () => {
    let matches = [
      match({ id: 34, label: "Q34", match_number: 34, phase: "ended", scheduled_time: iso(-60_000) }),
      match({ id: 37, label: "Q37", match_number: 37, scheduled_time: iso(300_000) }),
      match({ id: 35, label: "Q35", match_number: 35, field_id: 2, scheduled_time: iso(100_000) }),
    ];
    const { emit } = showField([], { extra: { "/api/matches?session_id=1": () => matches } });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    matches = matches.map((m) => (m.id === 34 ? { ...m, status: "completed" } : m));
    emit("score_saved", { match_id: 34 });
    expect(await screen.findByRole("heading", { name: "Qualification 37" })).toBeInTheDocument();
    matches = matches.map((m) => ({ ...m, status: "completed" }));
    emit("score_saved", { match_id: 37 });
    expect(await screen.findByText("No more matches on this field")).toBeInTheDocument();
  });

  it("a running time-out replaces everything until it ends", async () => {
    const group = fieldGroup({ field_set: { queued_match_id: null, timeout_deadline: iso(5_000) } });
    showField([match({ scheduled_time: iso(300_000) })], { group });
    expect(await screen.findByRole("heading", { name: "Time-out" })).toBeInTheDocument();
    expect(screen.getByTestId("timeout-clock")).toHaveTextContent("0:05");
    await act(() => vi.advanceTimersByTimeAsync(5_500));
    expect(await screen.findByTestId("start")).toBeInTheDocument();
  });
});

describe("audience In Match", () => {
  it("shows the field group's running match with rank chips, and the last ended one after", async () => {
    let matches = [match({ id: 5, label: "Q5", match_number: 5, field_id: 2, phase: "driver", phase_deadline: iso(30_000) })];
    const { emit } = showField([], {
      group: audienceGroup({ screen: "in_match" }),
      extra: {
        "/api/matches?session_id=1": () => matches,
        "/api/rankings?session_id=1": [{ team_id: 1, division_id: null, rank: 3, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 }],
      },
    });
    expect(await screen.findByRole("heading", { name: "Qualification 5" })).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:30");
    await waitFor(() => expect(screen.getByTestId("chip-1")).toHaveTextContent("3"));
    expect(screen.getByTestId("chip-2")).toHaveTextContent("–");
    matches = [{ ...matches[0], phase: "ended", phase_deadline: null }];
    emit("match_phase_changed", { match_id: 5 });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:00");
  });

  it("an audience screen is covered by a running time-out", async () => {
    const group = audienceGroup({ screen: "logo", field_set: { queued_match_id: null, timeout_deadline: iso(60_000) } });
    showField([], { group });
    expect(await screen.findByRole("heading", { name: "Time-out" })).toBeInTheDocument();
  });
});
