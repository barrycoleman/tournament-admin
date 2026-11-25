import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionFinalsRoute } from "../../src/routes/SessionFinalsRoute";
import type { FinalsExclusion, RankingRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const FINALIZED: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
  has_scored_matches: true,
  qualification_finalized_at: "2026-11-20T18:00:00Z",
  qualification_drops: {},
};
const OPEN: SessionRead = { ...FINALIZED, qualification_finalized_at: null, qualification_drops: null };

/** Six ranked teams; team id N is rank N and number "N00". */
const TEAMS = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  number: `${index + 1}00`,
  name: `Team ${index + 1}`,
  division_id: null,
}));

function ranking(teamId: number): RankingRead {
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

interface Stub {
  finalsFormat?: "single_elimination" | "score_chase";
  exclusions?: FinalsExclusion[];
}

function stub({ finalsFormat = "single_elimination", exclusions = [] }: Stub = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === "POST" && path === "/api/finals/exclusions") {
      return { id: 50, session_id: 1, division_id: null, team_id: 2, reason: "left_early" } as never;
    }
    if (options?.method === "DELETE") return undefined as never;
    if (options?.method === "POST" && path === "/api/finals/start") return { id: 9 } as never;
    if (path === "/api/divisions") return [] as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/rankings?session_id=1") return TEAMS.map((team) => ranking(team.id)) as never;
    if (path.startsWith("/api/rankings?")) return [] as never;
    if (path === "/api/finals/exclusions?session_id=1") return exclusions as never;
    if (path === "/api/finals?session_id=1") return [] as never;
    if (path === "/api/event/match-format") {
      return {
        finals_format: finalsFormat,
        alliance_selection: finalsFormat === "score_chase" ? "seed_pairing" : "captain_pick",
      } as never;
    }
    if (path === "/api/field-sets?session_id=1") {
      return [
        { id: 5, session_id: 1, name: "Main", division_id: null, purpose: "teamwork" },
        { id: 6, session_id: 1, name: "Skills", division_id: null, purpose: "skills" },
      ] as never;
    }
    if (path === "/api/fields?session_id=1") {
      return [
        { id: 11, field_set_id: 5, name: "Field 1" },
        { id: 12, field_set_id: 5, name: "Field 2" },
        { id: 21, field_set_id: 6, name: "Skills 1" },
      ] as never;
    }
    throw new Error(`unexpected request: ${options?.method ?? "GET"} ${path}`);
  });
}

function renderFinals(session: SessionRead) {
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

function startCall() {
  return vi.mocked(apiRequest).mock.calls.find(([path]) => path === "/api/finals/start");
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionFinalsRoute set-up", () => {
  it("asks for qualification to be finalized first", async () => {
    stub();
    renderFinals(OPEN);
    expect(
      await screen.findByText("Finalize qualification on the Matches page before generating finals.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Matches" })).toHaveAttribute("href", "/sessions/1/matches");
    expect(screen.queryByRole("button", { name: "Start alliance selection" })).not.toBeInTheDocument();
  });

  it("shows captains and invitable teams for partner picking", async () => {
    stub({ exclusions: [{ id: 40, session_id: 1, division_id: null, team_id: 1, reason: "disqualified" }] });
    renderFinals(FINALIZED);
    const row1 = await screen.findByRole("row", { name: /Team 1/ });
    await within(row1).findByText("Excluded: disqualified");
    fireEvent.change(screen.getByLabelText("Teams in finals"), { target: { value: "4" } });
    expect(within(screen.getByRole("row", { name: /Team 2/ })).getByText("Captain 1")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Team 3/ })).getByText("Captain 2")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Team 6/ })).getByText("Can be invited")).toBeInTheDocument();
    expect(screen.getByText("2 alliances")).toBeInTheDocument();
  });

  it("excludes a team with a reason and undoes an exclusion", async () => {
    stub({ exclusions: [{ id: 40, session_id: 1, division_id: null, team_id: 1, reason: "disqualified" }] });
    renderFinals(FINALIZED);
    const row2 = await screen.findByRole("row", { name: /Team 2/ });
    fireEvent.click(within(row2).getByRole("button", { name: "Exclude…" }));
    fireEvent.change(within(row2).getByLabelText("Reason"), { target: { value: "left_early" } });
    fireEvent.click(within(row2).getByRole("button", { name: "Exclude" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/finals/exclusions", {
        method: "POST",
        body: { session_id: 1, division_id: null, team_id: 2, reason: "left_early" },
      })
    );

    const row1 = screen.getByRole("row", { name: /Team 1/ });
    fireEvent.click(within(row1).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/finals/exclusions/40", { method: "DELETE" }));
  });

  it("starts partner picking with the chosen count, fields and games per round", async () => {
    stub();
    renderFinals(FINALIZED);
    await screen.findByRole("row", { name: /Team 6/ });
    fireEvent.change(screen.getByLabelText("Teams in finals"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Field 2" }));
    expect(screen.queryByRole("checkbox", { name: "Skills 1" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Final")).toHaveValue("best2of3");
    fireEvent.change(screen.getByLabelText("Final"), { target: { value: "best3of5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start alliance selection" }));
    await waitFor(() => expect(startCall()).toBeTruthy());
    expect(startCall()![1]).toEqual({
      method: "POST",
      body: {
        session_id: 1,
        division_id: null,
        team_count: 4,
        alliance_selection: "captain_pick",
        field_ids: [11],
        wins_to_advance: [3],
      },
    });
  });

  it("refuses an odd partner-picking count before sending anything", async () => {
    stub();
    renderFinals(FINALIZED);
    await screen.findByRole("row", { name: /Team 6/ });
    fireEvent.change(screen.getByLabelText("Teams in finals"), { target: { value: "5" } });
    expect(screen.getByText("Partner picking needs an even number of teams.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start alliance selection" })).toBeDisabled();
  });

  it("creates automatic pairs and shows the cut", async () => {
    stub();
    renderFinals(FINALIZED);
    await screen.findByRole("row", { name: /Team 6/ });
    fireEvent.click(screen.getByRole("radio", { name: "Automatic pairs" }));
    fireEvent.change(screen.getByLabelText("Teams in finals"), { target: { value: "4" } });
    expect(within(screen.getByRole("row", { name: /Team 4/ })).getByText("Alliance 2")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Team 5/ })).getByText("Not in finals")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create finals matches" }));
    await waitFor(() => expect(startCall()).toBeTruthy());
    expect(startCall()![1]).toMatchObject({
      body: { alliance_selection: "seed_pairing", team_count: 4, wins_to_advance: [2] },
    });
  });

  it("creates score-chase runs with every team and no games per round", async () => {
    stub({ finalsFormat: "score_chase" });
    renderFinals(FINALIZED);
    await screen.findByRole("row", { name: /Team 6/ });
    expect(screen.queryByRole("radio", { name: "Partner picking" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Final")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Teams in finals"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "All teams" }));
    expect(screen.getByLabelText("Teams in finals")).toHaveValue(6);
    fireEvent.change(screen.getByLabelText("Teams in finals"), { target: { value: "5" } });
    expect(within(screen.getByRole("row", { name: /Team 4/ })).getByText("Alliances 2 and 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create finals runs" }));
    await waitFor(() => expect(startCall()).toBeTruthy());
    expect(startCall()![1]).toEqual({
      method: "POST",
      body: {
        session_id: 1,
        division_id: null,
        team_count: 5,
        alliance_selection: "seed_pairing",
        field_ids: [11, 12],
      },
    });
  });

  it("shows the server's reason when starting is refused", async () => {
    stub();
    renderFinals(FINALIZED);
    await screen.findByRole("row", { name: /Team 6/ });
    vi.mocked(apiRequest).mockImplementationOnce(async () => {
      throw new ApiError(422, "Only 5 ranked teams available, need 6");
    });
    fireEvent.click(screen.getByRole("button", { name: "Start alliance selection" }));
    expect(await screen.findByText("Only 5 ranked teams available, need 6")).toBeInTheDocument();
  });

  it("refetches finals and exclusions on finals_changed", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      if (options.path === "/ws/session/1") onEvent = options.onEvent;
      return { connected: true };
    });
    stub();
    renderFinals(FINALIZED);
    await screen.findByRole("row", { name: /Team 6/ });
    vi.mocked(apiRequest).mockClear();
    onEvent!({ event: "finals_changed", data: { session_id: 1 } } as RealtimeEvent);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/finals/exclusions?session_id=1"));
    expect(apiRequest).toHaveBeenCalledWith("/api/finals?session_id=1");
  });
});
