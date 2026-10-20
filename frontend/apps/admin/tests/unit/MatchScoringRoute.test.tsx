import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n, type LiveMatch, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { MatchScoringRoute } from "../../src/routes/MatchScoringRoute";
import type { SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const AT = "2026-10-19T10:00:00Z";
const SESSION: SessionRead = {
  id: 1, event_id: 1, label: "Saturday", session_date: "2026-11-07", timezone: null, has_scored_matches: false,
  qualification_finalized_at: null, qualification_drops: null,
};
const SCHEMA = [
  {
    name: "balls", label: "Balls", data_type: "integer", widget: "counter", min: 0, max: 10, step: 1,
    options: null, icon: null, scope: "alliance", default: 0,
  },
];

let match: LiveMatch | ApiError;
let scores: Record<string, unknown>[];
let format: Record<string, unknown>;
let refuse: Record<string, unknown>;
let onEvent: ((event: RealtimeEvent) => void) | undefined;

function liveMatch(overrides: Partial<LiveMatch> = {}): LiveMatch {
  return {
    id: 7, session_id: 1, division_id: null, round_type: "qualification", match_number: 7, label: "Q7",
    field_id: 3, scheduled_time: null, status: "scheduled", phase: "driver",
    phase_deadline: new Date(Date.now() + 60_000).toISOString(), paused: false, remaining_seconds_at_pause: null,
    is_finals: false,
    alliances: [
      { id: 71, station: "red", team_ids: [1] },
      { id: 72, station: "blue", team_ids: [2] },
    ],
    ...overrides,
  };
}

function stub() {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in refuse) throw refuse[key];
    if (key === "GET /api/matches/7") {
      if (match instanceof ApiError) throw match;
      return match as never;
    }
    const routes: Record<string, unknown> = {
      "GET /api/teams": [
        { id: 1, number: "101A", name: "Rockets", division_id: null },
        { id: 2, number: "102B", name: "Gears", division_id: null },
      ],
      "GET /api/event/scoresheet-schema": SCHEMA,
      "GET /api/event/match-format": format,
      "GET /api/scores?session_id=1": scores,
      "GET /api/matches/7/draft": {
        match_id: 7,
        submitted: false,
        alliances: [
          { alliance_id: 71, data: { balls: 2 }, teams: [], item_meta: {}, version: 2, score: 2 },
          { alliance_id: 72, data: {}, teams: [], item_meta: {}, version: 0, score: 0 },
        ],
      },
    };
    if (key in routes) return routes[key] as never;
    if (key.startsWith("PATCH /api/matches/7/alliances/")) {
      const allianceId = Number(key.split("/")[5]);
      const changes = (options?.body as { changes: Record<string, unknown> }).changes;
      return { alliance_id: allianceId, data: changes, teams: [], item_meta: {}, version: 3, score: 0 } as never;
    }
    if (options?.method && options.method !== "GET") return {} as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/sessions/:sessionId",
        element: <SessionOutlet />,
        children: [
          { path: "matches/:matchId/score", element: <MatchScoringRoute /> },
          { path: "matches", element: <p>Matches list</p> },
        ],
      },
    ],
    { initialEntries: ["/sessions/1/matches/7/score"] }
  );
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  match = liveMatch();
  scores = [];
  format = { game_model: "head_to_head", autonomous_seconds: 15, driver_seconds: 105 };
  refuse = {};
  onEvent = undefined;
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockImplementation((options) => {
    onEvent = options.onEvent;
    return { connected: true };
  });
  stub();
});

describe("MatchScoringRoute", () => {
  it("scores an unsubmitted match live on the active-session channel", async () => {
    renderRoute();
    const red = await screen.findByRole("region", { name: "Red" });
    expect(screen.getByRole("heading", { name: "Score Q7" })).toBeInTheDocument();
    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    fireEvent.click(within(red).getByRole("button", { name: "Increase Balls" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/draft", { method: "PATCH", body: { changes: { balls: 3 } } })
    );

    const blue = screen.getByRole("region", { name: "Blue" });
    act(() =>
      onEvent?.({
        event: "score_draft_changed",
        data: {
          match_id: 7, alliance_id: 72, data: { balls: 5 }, teams: [],
          item_meta: { balls: { device_name: "Field 2 tablet", at: AT } }, version: 1, score: 5,
        },
      })
    );
    expect(within(blue).getByText("Changed by Field 2 tablet")).toBeInTheDocument();
  });

  it("refetches the match on its clock events", async () => {
    renderRoute();
    await screen.findByRole("region", { name: "Red" });
    match = liveMatch({ paused: true, phase_deadline: null, remaining_seconds_at_pause: 30 });
    act(() => onEvent?.({ event: "match_paused", data: { match_id: 7 } }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("shows a submitted match read-only and corrects it through the score endpoint", async () => {
    match = liveMatch({ status: "completed", phase: "ended", phase_deadline: null });
    scores = [
      { match_id: 7, alliance_id: 71, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
      { match_id: 7, alliance_id: 72, score: 1, data: { balls: 1 }, teams: [{ team_id: 2, no_show: false, dq: true }], saved_at: AT },
    ];
    stub();
    renderRoute();
    const red = await screen.findByRole("region", { name: "Red" });
    expect(red).toHaveTextContent("Score: 6");
    expect(screen.getByRole("region", { name: "Blue" })).toHaveTextContent("102B (DQ)");
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Correct score" }));
    const editRed = screen.getByRole("region", { name: "Red" });
    fireEvent.click(within(editRed).getByRole("button", { name: "Increase Balls" }));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/72/score", {
        method: "POST",
        body: { data: { balls: 1 }, teams: [{ team_id: 2, no_show: false, dq: true }], force: false },
      })
    );
    expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/score", {
      method: "POST",
      body: { data: { balls: 7 }, teams: [], force: false },
    });
    expect(await screen.findByText("Score corrected.")).toBeInTheDocument();
  });

  it("shows the rules' problems on a correction and saves anyway", async () => {
    match = liveMatch({ status: "completed", phase: "ended", phase_deadline: null });
    scores = [
      { match_id: 7, alliance_id: 71, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
      { match_id: 7, alliance_id: 72, score: 1, data: { balls: 1 }, teams: [], saved_at: AT },
    ];
    refuse["POST /api/matches/7/alliances/71/score"] = new ApiError(422, "", { detail: { violations: ["balls look wrong"] } });
    stub();
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Correct score" }));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    const problems = await screen.findByRole("alert");
    expect(problems).toHaveTextContent("balls look wrong");
    delete refuse["POST /api/matches/7/alliances/71/score"];
    fireEvent.click(within(problems).getByRole("button", { name: "Save anyway" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/score", {
        method: "POST",
        body: { data: { balls: 6 }, teams: [], force: true },
      })
    );
  });

  it("corrects a cooperative match's shared sheet on every alliance", async () => {
    format = { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60 };
    match = liveMatch({ status: "completed", phase: "ended", phase_deadline: null });
    scores = [
      { match_id: 7, alliance_id: 71, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
      { match_id: 7, alliance_id: 72, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
    ];
    stub();
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Correct score" }));
    const shared = screen.getByRole("region", { name: "Shared score" });
    fireEvent.click(within(shared).getByRole("button", { name: "Decrease Balls" }));
    fireEvent.click(within(shared).getByLabelText("No-show 102B"));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/72/score", {
        method: "POST",
        body: { data: { balls: 5 }, teams: [{ team_id: 2, no_show: true, dq: false }], force: false },
      })
    );
    expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/score", {
      method: "POST",
      body: { data: { balls: 5 }, teams: [], force: false },
    });
  });

  it("says the match is no longer available when it is gone", async () => {
    match = new ApiError(404, "Match not found");
    stub();
    renderRoute();
    expect(await screen.findByText("This match is no longer available.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to matches" })).toHaveAttribute("href", "/sessions/1/matches");
  });
});
