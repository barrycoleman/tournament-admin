import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalsBracket } from "../../src/display/api";
import { baseRoutes, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-07T16:00:00Z").getTime());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ranking = (team_id: number, rank: number) => ({
  team_id, rank, division_id: null, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 0,
});

function bracket(overrides: Partial<FinalsBracket>): FinalsBracket {
  return {
    id: 1, session_id: 1, division_id: null, field_set_id: 10, format: "single_elimination", bracket_size: 4,
    status: "selecting_alliances", alliance_selection: "captain_pick", alliances: [], runs: [], results: [], matchups: [],
    selection: null, ...overrides,
  };
}

function serve(finals: FinalsBracket[]) {
  serveDisplay({
    ...baseRoutes(),
    "/api/displays/me": me(pitGroup({ screen: "alliance_selection" })),
    "/api/rankings?session_id=1": [ranking(1, 1), ranking(2, 2), ranking(3, 3), ranking(4, 4)],
    "/api/finals?session_id=1&division_id=4": [],
    "/api/finals?session_id=1": finals,
  });
}

describe("Alliance selection", () => {
  it("shows the alliances, the pending invite and the available teams with ranks", async () => {
    serve([
      bracket({
        alliances: [{ id: 1, seed: 1, team_ids: [1, 4], unavailable: false }],
        selection: {
          captain_team_id: 2, invitable_team_ids: [3], declined_team_ids: [], pending_team_id: 3,
          alliances_formed: 1, alliances_target: 2, last_step: null,
        },
      }),
    ]);
    renderDisplay();
    expect(await screen.findByTestId("alliance-row-1")).toHaveTextContent("1101A104D");
    expect(screen.getByRole("heading", { name: "Alliance selection" })).toBeInTheDocument();
    expect(screen.getByTestId("alliance-row-2")).toHaveTextContent("2102B103C ?");
    expect(screen.getByTestId("pending-invite")).toHaveTextContent("102B invites 103C");
    expect(screen.getByTestId("available-team-103C")).toHaveTextContent("#3");
  });

  it("lists available teams in rank order with declined teams struck through", async () => {
    serve([
      bracket({
        selection: {
          captain_team_id: 1, invitable_team_ids: [3, 4], declined_team_ids: [2], pending_team_id: null,
          alliances_formed: 0, alliances_target: 2, last_step: null,
        },
      }),
    ]);
    renderDisplay();
    await screen.findByTestId("alliance-row-1");
    const available = screen.getAllByTestId(/^available-team-/);
    expect(available.map((el) => el.textContent)).toEqual(["#2 102B", "#3 103C", "#4 104D"]);
    expect(available[0]).toHaveClass("is-declined");
    expect(available[1]).not.toHaveClass("is-declined");
    expect(screen.queryByTestId("pending-invite")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("alliance-row-1")).getByText("101A")).toBeInTheDocument();
  });

  it("keeps the full alliance list once selection is finished", async () => {
    serve([
      bracket({
        status: "in_progress",
        alliances: [
          { id: 1, seed: 1, team_ids: [1, 4], unavailable: false },
          { id: 2, seed: 2, team_ids: [2, 3], unavailable: false },
        ],
      }),
    ]);
    renderDisplay();
    expect(await screen.findByTestId("alliance-row-2")).toHaveTextContent("2102B103C");
    expect(screen.getByTestId("alliance-row-1")).toHaveTextContent("101A");
    expect(screen.queryByTestId("available-team-103C")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alliance selection" })).toBeInTheDocument();
  });

  it("shows a notice when no bracket is picking alliances", async () => {
    serve([bracket({ alliance_selection: "seed_pairing", status: "in_progress" })]);
    renderDisplay();
    expect(await screen.findByText("Alliance selection hasn't started")).toBeInTheDocument();
  });

  it("shows the notice when there are no finals at all", async () => {
    serve([]);
    renderDisplay();
    expect(await screen.findByText("Alliance selection hasn't started")).toBeInTheDocument();
  });
});
