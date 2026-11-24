import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, HEAD_TO_HEAD, audienceGroup, baseRoutes, fieldGroup, match, me } from "./displayFixtures";
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

const COOP_ALLIANCES = [
  { id: 1001, station: "red", team_ids: [1] },
  { id: 1002, station: "blue", team_ids: [4] },
];

describe("field display", () => {
  it("fills the screen with each side's team numbers, with the match and countdown in the bottom bar", async () => {
    showField([match({ id: 7, label: "Q7", match_number: 7, scheduled_time: iso(83_000) })]);
    const bar = await screen.findByTestId("bottom-bar");
    expect(bar).toHaveTextContent("Qualification 7");
    expect(bar).toHaveTextContent("Field 1");
    expect(screen.queryByRole("heading", { name: "Qualification 7" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("band-red")).getByText("101A")).toBeInTheDocument();
    expect(within(screen.getByTestId("band-red")).getByText("102B")).toBeInTheDocument();
    expect(within(screen.getByTestId("band-blue")).getByText("104D")).toBeInTheDocument();
    expect(screen.getByTestId("band-red")).toHaveClass("team-band--fill");
    const start = within(bar).getByTestId("start");
    expect(start.querySelector(".start__label")).toHaveTextContent("Starts in");
    expect(start.querySelector(".start__time")).toHaveTextContent("1:23");
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
    expect(screen.getByTestId("start").querySelector(".start__label")).toHaveTextContent("Late by");
    expect(screen.getByTestId("start").querySelector(".start__time")).toHaveTextContent("0:00");
  });

  it("uses the server's clock, not the TV's", async () => {
    // The server is a minute ahead: 80 s away on the TV's clock is 20 s away for real.
    showField([match({ scheduled_time: iso(80_000) })], { offset: 60_000 });
    await screen.findByTestId("start");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "soon");
  });

  it("shows Up next for a match with no scheduled time, and a red and a blue band for a cooperative game", async () => {
    showField([match({ scheduled_time: null, alliances: COOP_ALLIANCES })], { extra: { "/api/event/match-format": COOPERATIVE } });
    expect(await screen.findByTestId("start")).toHaveTextContent("Up next");
    expect(screen.getByTestId("band-red")).toHaveTextContent("101A");
    expect(screen.getByTestId("band-blue")).toHaveTextContent("104D");
    expect(screen.getByTestId("band-red")).not.toHaveTextContent("104D");
    expect(screen.queryByTestId("band-all")).not.toBeInTheDocument();
  });

  it("puts the better-ranked team of a score-chase run on red", async () => {
    showField([match({ scheduled_time: null, alliances: [{ id: 1001, station: "solo", team_ids: [1, 4] }] })], {
      extra: {
        "/api/rankings?session_id=1": [
          { team_id: 1, division_id: null, rank: 9, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 },
          { team_id: 4, division_id: null, rank: 2, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 },
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId("band-red")).toHaveTextContent("104D"));
    expect(screen.getByTestId("band-blue")).toHaveTextContent("101A");
  });

  it("counts in with 3-2-1 on a full-screen overlay that covers the bands", async () => {
    showField([match({ phase: "countdown_autonomous", phase_deadline: iso(2_500) })]);
    const overlay = await screen.findByTestId("count-in");
    expect(overlay).toHaveTextContent("3");
    // The overlay is fixed over the whole screen, so nothing shows above it.
    expect(overlay).toHaveClass("count-in-overlay");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByTestId("count-in")).toHaveTextContent("2");
  });

  it("shows the period clock under the team bands, a paused indicator and Driver control next", async () => {
    let matches = [match({ id: 3, phase: "driver", phase_deadline: iso(95_000) })];
    const { emit } = showField([], { extra: { "/api/matches?session_id=1": () => matches } });
    expect(await screen.findByTestId("clock")).toHaveTextContent("1:35");
    expect(screen.queryByTestId(/^chip-/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("band-red")).toHaveTextContent("101A"));
    expect(screen.getByTestId("band-red")).toHaveTextContent("102B");
    expect(screen.getByTestId("band-blue")).toHaveTextContent("103C");
    expect(screen.getByTestId("band-blue")).toHaveTextContent("104D");
    expect(screen.getByTestId("band-red")).not.toHaveTextContent("103C");
    expect(screen.getByTestId("bottom-bar")).toHaveTextContent("Qualification 3");
    expect(screen.getByTestId("bottom-bar")).toHaveTextContent("Field 1");
    expect(screen.getByTestId("period")).toHaveTextContent("Driver control");
    expect(screen.queryByTestId("paused")).not.toBeInTheDocument();
    matches = [match({ id: 3, phase: "driver", paused: true, remaining_seconds_at_pause: 40 })];
    emit("match_paused", { match_id: 3 });
    expect(await screen.findByTestId("paused")).toHaveTextContent("Paused");
    expect(screen.queryByTestId("period")).not.toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:40");
    matches = [match({ id: 3, phase: "awaiting_driver" })];
    emit("match_phase_changed", { match_id: 3 });
    expect(await screen.findByText("Driver control next")).toBeInTheDocument();
    expect(screen.getByTestId("band-red")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-bar")).toBeInTheDocument();
    matches = [match({ id: 3, phase: "ended" })];
    emit("match_phase_changed", { match_id: 3 });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:00");
  });

  it("swaps the period name for a Driver change tag from 35 s down to 25 s left", async () => {
    showField([match({ phase: "driver", phase_deadline: iso(30_000) })]);
    expect(await screen.findByTestId("window-tag")).toHaveTextContent("Driver change");
    expect(screen.queryByTestId("period")).not.toBeInTheDocument();
  });

  it("shows any window's own label from the game's moments", async () => {
    const endgame = { key: "endgame", label: "Endgame", period: "driver", at_remaining: 20, until_remaining: 0 };
    showField([match({ phase: "driver", phase_deadline: iso(15_000) })], {
      extra: { "/api/event/match-format": { ...HEAD_TO_HEAD, moments: [endgame] } },
    });
    expect(await screen.findByTestId("window-tag")).toHaveTextContent("Endgame");
    expect(screen.queryByTestId("period")).not.toBeInTheDocument();
  });

  it("shows the period name outside the driver-change window", async () => {
    showField([match({ phase: "driver", phase_deadline: iso(40_000) })]);
    expect(await screen.findByTestId("period")).toHaveTextContent("Driver control");
    expect(screen.queryByTestId("window-tag")).not.toBeInTheDocument();
  });

  it("shows the Driver change tag for a cooperative game with a 60 s driver period", async () => {
    showField([match({ phase: "driver", phase_deadline: iso(30_000), alliances: COOP_ALLIANCES })], {
      extra: { "/api/event/match-format": COOPERATIVE },
    });
    expect(await screen.findByTestId("window-tag")).toBeInTheDocument();
    expect(screen.getByTestId("band-red")).toHaveTextContent("101A");
    expect(screen.getByTestId("band-blue")).toHaveTextContent("104D");
  });

  it("never shows the Driver change tag when the game declares no window", async () => {
    showField([match({ phase: "driver", phase_deadline: iso(30_000) })], {
      extra: { "/api/event/match-format": { ...HEAD_TO_HEAD, moments: [] } },
    });
    expect(await screen.findByTestId("period")).toHaveTextContent("Driver control");
    expect(screen.queryByTestId("window-tag")).not.toBeInTheDocument();
  });

  it("shows Paused, not the Driver change tag, when paused inside the window", async () => {
    showField([match({ phase: "driver", paused: true, remaining_seconds_at_pause: 30 })]);
    expect(await screen.findByTestId("paused")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:30");
    expect(screen.queryByTestId("window-tag")).not.toBeInTheDocument();
    expect(screen.queryByTestId("period")).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId("bottom-bar")).toHaveTextContent("Qualification 37"));
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
  it("shows the field group's running match with team bands, and the last ended one after", async () => {
    let matches = [match({ id: 5, label: "Q5", match_number: 5, field_id: 2, phase: "driver", phase_deadline: iso(30_000) })];
    const { emit } = showField([], {
      group: audienceGroup({ screen: "in_match" }),
      extra: {
        "/api/matches?session_id=1": () => matches,
        "/api/rankings?session_id=1": [{ team_id: 1, division_id: null, rank: 3, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 }],
      },
    });
    expect(await screen.findByTestId("clock")).toHaveTextContent("0:30");
    expect(screen.getByTestId("bottom-bar")).toHaveTextContent("Qualification 5");
    expect(screen.getByTestId("bottom-bar")).toHaveTextContent("Field 2");
    // Numbers only: no rank, even once the rankings have loaded.
    await waitFor(() => expect(screen.getByTestId("band-red")).toHaveTextContent(/^101A102B$/));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.getByTestId("band-red")).toHaveTextContent(/^101A102B$/);
    expect(screen.getByTestId("band-blue")).toHaveTextContent(/^103C104D$/);
    expect(screen.queryByTestId(/^chip-/)).not.toBeInTheDocument();
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
