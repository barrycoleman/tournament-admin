import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionRankingsRoute } from "../../src/routes/SessionRankingsRoute";
import type { Division, GameModel, RankingRead, RankingSettingsRead, SessionRead, SkillsRankingRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
  has_scored_matches: true,
  qualification_finalized_at: null,
  qualification_drops: null,
};
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: 7 },
  { id: 2, number: "202", name: "Bravo", division_id: 7 },
  { id: 3, number: "303", name: "Charlie", division_id: 8 },
];

function ranking(team_id: number, rank: number, overrides: Partial<RankingRead> = {}): RankingRead {
  return {
    session_id: 1,
    division_id: null,
    team_id,
    rank,
    win_points: 0,
    strength_of_schedule: 0,
    average_score: 0,
    matches_played: 0,
    ...overrides,
  };
}

function settings(game_model: GameModel): RankingSettingsRead {
  return {
    session_drop_mode: "tiered",
    session_drop_count: 1,
    session_drop_no_show: false,
    session_drop_dq: false,
    season_keep_best: null,
    season_only_session_counted: false,
    season_minimum: 0,
    season_drop_no_show: false,
    season_drop_dq: false,
    game_model,
  };
}

const SKILL_TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

function stub({
  gameModel = "cooperative_score",
  divisions = [],
  rankings = {},
  skillsEnabled = false,
  skillsRankings = {},
}: {
  gameModel?: GameModel;
  divisions?: Division[];
  rankings?: Record<string, RankingRead[]>;
  skillsEnabled?: boolean;
  skillsRankings?: Record<string, SkillsRankingRead[]>;
}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/ranking-settings") return settings(gameModel) as never;
    if (path === "/api/divisions") return divisions as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/skills/settings") {
      return { enabled: skillsEnabled, attempts: { autonomous: 3, driver: 3 }, types: SKILL_TYPES } as never;
    }
    if (path.startsWith("/api/skills/rankings?")) return (skillsRankings[path] ?? []) as never;
    if (path in rankings) return rankings[path] as never;
    if (path.startsWith("/api/rankings?")) return [] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderRankings() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionRankingsRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const ROOKIE: Division = { id: 7, event_id: 1, name: "Rookie", target_team_count: null };
const OPEN: Division = { id: 8, event_id: 1, name: "Open", target_team_count: null };

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionRankingsRoute", () => {
  it("shows cooperative columns in rank order with two-decimal scores", async () => {
    stub({
      rankings: {
        "/api/rankings?session_id=1": [
          ranking(1, 1, { average_score: 25, matches_played: 3 }),
          ranking(2, 2, { average_score: 12.5, matches_played: 2 }),
        ],
      },
    });
    renderRankings();

    const alpha = await screen.findByRole("row", { name: /Alpha/ });
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Matches played" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Win points" })).not.toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "25.00" })).toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "101" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")[1]).toBe(alpha);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("shows head-to-head columns", async () => {
    stub({
      gameModel: "head_to_head",
      rankings: { "/api/rankings?session_id=1": [ranking(1, 1, { win_points: 4, strength_of_schedule: 6 })] },
    });
    renderRankings();

    const alpha = await screen.findByRole("row", { name: /Alpha/ });
    expect(screen.getByRole("columnheader", { name: "Win points" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Strength of schedule" })).toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "4" })).toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "6" })).toBeInTheDocument();
  });

  it("shows matches with no division even when the event has a division", async () => {
    stub({ divisions: [ROOKIE], rankings: { "/api/rankings?session_id=1": [ranking(1, 1)] } });
    renderRankings();

    expect(await screen.findByRole("row", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("groups rankings by division under headings", async () => {
    stub({
      divisions: [ROOKIE, OPEN],
      rankings: {
        "/api/rankings?session_id=1&division_id=7": [ranking(1, 1, { division_id: 7 })],
        "/api/rankings?session_id=1&division_id=8": [ranking(3, 1, { division_id: 8 })],
      },
    });
    renderRankings();

    expect(await screen.findByRole("heading", { name: "Rookie" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open" })).toBeInTheDocument();
    expect(await within(screen.getByRole("table", { name: "Rookie" })).findByText("Alpha")).toBeInTheDocument();
    expect(await within(screen.getByRole("table", { name: "Open" })).findByText("Charlie")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is ranked", async () => {
    stub({});
    renderRankings();

    expect(
      await screen.findByText("No rankings yet. Rankings appear once qualification matches are scored.")
    ).toBeInTheDocument();
  });

  it("refetches when the session channel reports a ranking update", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      if (options.path === "/ws/session/1") onEvent = options.onEvent;
      return { connected: true };
    });
    stub({ rankings: { "/api/rankings?session_id=1": [ranking(1, 1)] } });
    renderRankings();
    await screen.findByRole("row", { name: /Alpha/ });

    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/session/1");
    const fetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/rankings?session_id=1").length;
    const before = fetches();
    act(() => onEvent?.({ event: "ranking_updated", data: { session_id: 1 } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
  });

  it("shows only the Teamwork tab while skills are off", async () => {
    stub({ rankings: { "/api/rankings?session_id=1": [ranking(1, 1)] } });
    renderRankings();
    await screen.findByRole("row", { name: /Alpha/ });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/skills/settings"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Teamwork"]);
  });

  it("adds a tab per skills type and Overall Skills, and shows a skills table", async () => {
    stub({
      skillsEnabled: true,
      skillsRankings: {
        "/api/skills/rankings?tab=overall&session_id=1": [
          { rank: 1, team_id: 2, score: 58, attempts: [28, 30], session_id: 1 },
          { rank: 2, team_id: 1, score: 54, attempts: [20, 34], session_id: 1 },
        ],
      },
    });
    renderRankings();
    await screen.findByRole("tab", { name: "Overall Skills" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Teamwork",
      "Autonomous",
      "Driver",
      "Overall Skills",
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "Overall Skills" }));
    expect(screen.getByRole("tab", { name: "Overall Skills" })).toHaveAttribute("aria-selected", "true");
    const table = await screen.findByRole("table", { name: "Overall Skills" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("202");
    expect(rows[1]).toHaveTextContent("58");
    expect(rows[1]).toHaveTextContent("28 · 30");
    expect(within(table).queryByRole("columnheader", { name: "From session" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Sum of each team's best attempt/)).toBeInTheDocument();
  });

  it("shows the empty state on a skills tab with no attempts", async () => {
    stub({ skillsEnabled: true });
    renderRankings();
    fireEvent.click(await screen.findByRole("tab", { name: "Driver" }));
    expect(await screen.findByText("No skills attempts recorded yet.")).toBeInTheDocument();
  });
});

describe("SessionRankingsRoute channel", () => {
  it("listens on the channel its outlet context names", async () => {
    stub({});
    const i18n = initI18n({ en: { translation: enAdmin } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      {
        path: "/",
        element: <Outlet context={{ session: SESSION, channelPath: "/ws/active-session" }} />,
        children: [{ index: true, element: <SessionRankingsRoute /> }],
      },
    ]);
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(useRealtimeChannel).toHaveBeenCalled());
    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
  });
});
