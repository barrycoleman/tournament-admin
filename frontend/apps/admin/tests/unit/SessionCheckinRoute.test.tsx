import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionCheckinRoute } from "../../src/routes/SessionCheckinRoute";
import type { SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
  has_scored_matches: false,
  qualification_finalized_at: null,
  qualification_drops: null,
};

function TestLayout() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    {
      path: "/",
      element: <TestLayout />,
      children: [{ index: true, element: <SessionCheckinRoute /> }],
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

describe("SessionCheckinRoute", () => {
  it("shows a team with no participation row as unchecked", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders", division_id: null }] as never;
      }
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/sessions/1/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const checkbox = await screen.findByLabelText("Toggle check-in for Robo Raiders");
    expect(checkbox).not.toBeChecked();
  });

  it("shows a checked-in team as checked, and toggling posts the new state", async () => {
    let postBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders", division_id: null }] as never;
      }
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/sessions/1/participants" && !options) {
        return [{ id: 1, session_id: 1, team_id: 1, checked_in: true }] as never;
      }
      if (path === "/api/sessions/1/participants" && (options as { method?: string })?.method === "POST") {
        postBody = (options as { body: unknown }).body;
        return { id: 1, session_id: 1, team_id: 1, checked_in: false } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const checkbox = await screen.findByLabelText("Toggle check-in for Robo Raiders");
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => expect(postBody).toEqual({ team_id: 1, checked_in: false }));
  });

  it("only shows the Division column when the event has more than one division", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/teams") return [] as never;
      if (path === "/api/divisions") return [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }] as never;
      if (path === "/api/sessions/1/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Number");
    expect(screen.queryByText("Division")).not.toBeInTheDocument();
  });

  it("narrows visible rows when filtering by number or name", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/teams") {
        return [
          { id: 1, number: "1234A", name: "Robo Raiders", division_id: null },
          { id: 2, number: "5678B", name: "Circuit Breakers", division_id: null },
        ] as never;
      }
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/sessions/1/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("1234A");
    expect(screen.getByText("5678B")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Filter by number or name"), {
      target: { value: "5678B" },
    });

    expect(screen.queryByText("1234A")).not.toBeInTheDocument();
    expect(screen.getByText("5678B")).toBeInTheDocument();
  });

  it("checking in all visible posts only for teams matching the active filter", async () => {
    const postedTeamIds: number[] = [];
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/teams") {
        return [
          { id: 1, number: "1234A", name: "Robo Raiders", division_id: null },
          { id: 2, number: "5678B", name: "Circuit Breakers", division_id: null },
        ] as never;
      }
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/sessions/1/participants" && !options) return [] as never;
      if (
        path === "/api/sessions/1/participants" &&
        (options as { method?: string })?.method === "POST"
      ) {
        const body = (options as { body: { team_id: number; checked_in: boolean } }).body;
        postedTeamIds.push(body.team_id);
        return {
          id: body.team_id,
          session_id: 1,
          team_id: body.team_id,
          checked_in: body.checked_in,
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("1234A");
    fireEvent.change(screen.getByPlaceholderText("Filter by number or name"), {
      target: { value: "5678B" },
    });
    await waitFor(() => expect(screen.queryByText("1234A")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Check in all visible" }));

    await waitFor(() => expect(postedTeamIds).toEqual([2]));
    expect(postedTeamIds).not.toContain(1);
  });
});

describe("SessionCheckinRoute — progress and next step", () => {
  const FORMAT = {
    round_types: ["qualification"],
    teams_per_alliance: 2,
    alliance_count: 2,
    match_duration_seconds: 120,
    default_cycle_time_seconds: null,
  };
  const team = (id: number, divisionId: number | null) => ({
    id,
    number: `${id}00`,
    name: `Team ${id}`,
    division_id: divisionId,
  });

  function stub(teams: ReturnType<typeof team>[], checkedIds: number[], divisions: unknown[] = []) {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/teams") return teams as never;
      if (path === "/api/divisions") return divisions as never;
      if (path === "/api/event") return { id: 1, name: "E", active_session_id: 1, game_plugin_name: "demo" } as never;
      if (path === "/api/event/match-format") return FORMAT as never;
      if (path === "/api/sessions/1/participants") {
        return checkedIds.map((id) => ({ id, session_id: 1, team_id: id, checked_in: true })) as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
  }

  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it("shows how many teams are checked in", async () => {
    stub([team(1, null), team(2, null), team(3, null)], [1, 3]);
    renderRoute();
    expect(await screen.findByText("2 of 3 checked in")).toBeInTheDocument();
    expect(screen.queryByText("plan matches")).not.toBeInTheDocument();
  });

  it("offers to plan matches once enough teams fill a match", async () => {
    stub([1, 2, 3, 4, 5].map((id) => team(id, null)), [1, 2, 3, 4]);
    renderRoute();
    expect(await screen.findByText("4 of 5 checked in")).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "plan matches" });
    expect(link).toHaveAttribute("href", "/sessions/1/schedule");
    expect(link.closest(".next-step")).toHaveTextContent("Next: plan matches");
  });

  it("waits until every division can fill a match", async () => {
    const divisions = [
      { id: 1, event_id: 1, name: "Red", target_team_count: null },
      { id: 2, event_id: 1, name: "Blue", target_team_count: null },
    ];
    const teams = [1, 2, 3, 4].map((id) => team(id, 1)).concat([5, 6, 7].map((id) => team(id, 2)));
    stub(teams, [1, 2, 3, 4, 5, 6, 7], divisions);
    renderRoute();
    expect(await screen.findByText("7 of 7 checked in")).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(apiRequest).mock.calls.some((c) => c[0] === "/api/event/match-format")).toBe(true));
    expect(screen.queryByRole("link", { name: "plan matches" })).not.toBeInTheDocument();
  });
});
