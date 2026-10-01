import { describe, expect, it, vi } from "vitest";
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
