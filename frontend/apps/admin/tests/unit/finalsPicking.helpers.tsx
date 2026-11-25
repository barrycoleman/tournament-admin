import { render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionFinalsRoute } from "../../src/routes/SessionFinalsRoute";
import type { FinalsBracket, RankingRead, SessionRead } from "../../src/types";

export const FINALIZED: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
  has_scored_matches: true,
  qualification_finalized_at: "2026-11-20T18:00:00Z",
  qualification_drops: {},
};

/** Eight ranked teams; team id N is rank N and number "N00". */
export const TEAMS = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  number: `${index + 1}00`,
  name: `Team ${index + 1}`,
  division_id: null,
}));

export function ranking(teamId: number): RankingRead {
  return {
    session_id: 1,
    division_id: null,
    team_id: teamId,
    rank: teamId,
    win_points: 0,
    strength_of_schedule: 0,
    average_score: 0,
    matches_played: 3,
  };
}

export function bracket(overrides: Partial<FinalsBracket> = {}): FinalsBracket {
  return {
    id: 9,
    session_id: 1,
    division_id: null,
    field_set_id: 5,
    format: "single_elimination",
    bracket_size: 4,
    alliance_selection: "captain_pick",
    field_ids: [11],
    wins_to_advance: [1, 1],
    status: "in_progress",
    alliances: [],
    runs: [],
    results: [],
    matchups: [],
    selection: null,
    ...overrides,
  };
}

/** Stubs the route's reads; `brackets` is what the finals list returns. Other requests go to `other`. */
export function stubReads(
  brackets: () => FinalsBracket[],
  other: (path: string, options?: { method?: string; body?: unknown }) => unknown
) {
  return async (path: string, options?: { method?: string; body?: unknown }) => {
    if (!options?.method || options.method === "GET") {
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/teams") return TEAMS as never;
      if (path === "/api/rankings?session_id=1") return TEAMS.map((team) => ranking(team.id)) as never;
      if (path.startsWith("/api/rankings?")) return [] as never;
      if (path === "/api/finals?session_id=1") return brackets() as never;
    }
    return other(path, options) as never;
  };
}

export function renderFinals(session: SessionRead = FINALIZED) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    {
      path: "/",
      element: <Outlet context={{ session }} />,
      children: [{ index: true, element: <SessionFinalsRoute /> }],
    },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}
