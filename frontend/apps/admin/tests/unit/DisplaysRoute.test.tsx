import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DisplaysRoute } from "../../src/routes/DisplaysRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const group = (overrides: Record<string, unknown>) => ({
  session_id: 1,
  field_set_id: 10,
  field_id: null,
  division_id: null,
  screen: null,
  screen_settings: {},
  rotation: null,
  play_sounds: false,
  displays: [],
  ...overrides,
});

let displays: Record<string, unknown>;

function stub(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) return overrides[key] as never;
    const routes: Record<string, unknown> = {
      "GET /api/event": {
        id: 1,
        name: "E",
        active_session_id: 1,
        game_plugin_name: null,
        game_plugin_locked: false,
        created_at: "",
      },
      "GET /api/sessions": [
        {
          id: 1,
          label: "Saturday",
          session_date: null,
          timezone: null,
          has_scored_matches: false,
        },
        {
          id: 2,
          label: "Sunday",
          session_date: null,
          timezone: null,
          has_scored_matches: false,
        },
      ],
      "GET /api/divisions": [{ id: 4, name: "Division 1" }],
      "GET /api/displays?session_id=1": displays,
      "GET /api/displays?session_id=2": {
        session_id: 2,
        groups: [],
        unassigned: [],
        has_setup: false,
      },
    };
    if (key in routes) return routes[key] as never;
    if (options?.method && options.method !== "GET") return displays as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <DisplaysRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  displays = {
    session_id: 1,
    has_setup: true,
    groups: [
      group({
        id: 50,
        kind: "audience",
        name: "Main Fields",
        screen: "logo",
        displays: [{ device_id: 7, name: "Big TV", online: true }],
      }),
      group({ id: 51, kind: "field", name: "Field 1", field_id: 1 }),
      group({
        id: 52,
        kind: "pit",
        name: "Pit TVs",
        field_set_id: null,
        screen: "teamwork_rankings",
        division_id: 4,
      }),
    ],
    unassigned: [{ device_id: 8, name: "Spare TV", online: false }],
  };
  stub();
});

describe("Displays page", () => {
  it("lists field groups with their audience and field groups, pit groups and unassigned displays", async () => {
    renderRoute();
    const main = await screen.findByRole("region", { name: "Main Fields" });
    expect(within(main).getByText("Big TV")).toBeInTheDocument();
    expect(within(main).getByText("Online")).toBeInTheDocument();
    expect(within(main).getByText("Field 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pit TVs" })).toBeInTheDocument();
    const unassigned = screen.getByRole("region", {
      name: "Unassigned displays",
    });
    expect(within(unassigned).getByText("Spare TV")).toBeInTheDocument();
    expect(within(unassigned).getByText("Offline")).toBeInTheDocument();
  });

  it("sets the audience screen and sounds", async () => {
    renderRoute();
    const main = await screen.findByRole("region", { name: "Main Fields" });
    fireEvent.change(within(main).getByLabelText("Audience screen"), {
      target: { value: "schedule" },
    });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", {
        method: "PATCH",
        body: { screen: "schedule" },
      }),
    );
    fireEvent.click(within(main).getByLabelText("Play sounds"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", {
        method: "PATCH",
        body: { play_sounds: true },
      }),
    );
  });

  it("moves and identifies displays", async () => {
    renderRoute();
    const unassigned = await screen.findByRole("region", {
      name: "Unassigned displays",
    });
    fireEvent.change(within(unassigned).getByLabelText("Put Spare TV in a group"), { target: { value: "52" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 8, group_id: 52 },
      }),
    );
    fireEvent.click(within(unassigned).getByRole("button", { name: "Identify Spare TV" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/8/identify", {
        method: "POST",
      }),
    );
    const main = screen.getByRole("region", { name: "Main Fields" });
    fireEvent.change(within(main).getByLabelText("Move Big TV"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 7, group_id: null },
      }),
    );
  });

  it("adds a pit group", async () => {
    renderRoute();
    fireEvent.change(await screen.findByLabelText("Pit group name"), {
      target: { value: "Hallway" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add pit group" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/pit-groups", {
        method: "POST",
        body: { session_id: 1, name: "Hallway", division_id: null },
      }),
    );
  });

  it("builds and saves a pit rotation", async () => {
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.click(within(pit).getByLabelText("Rotate through screens"));
    fireEvent.click(within(pit).getByRole("button", { name: "Add screen" }));
    fireEvent.change(within(pit).getByLabelText("Screen 2"), {
      target: { value: "upcoming_matches" },
    });
    fireEvent.change(within(pit).getByLabelText("Seconds for screen 2"), {
      target: { value: "30" },
    });
    expect(within(pit).queryByLabelText("Seconds for screen 1")).not.toBeInTheDocument();
    fireEvent.click(within(pit).getByRole("button", { name: "Save rotation" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/52", {
        method: "PATCH",
        body: {
          rotation: [
            { screen: "teamwork_rankings", settings: {}, seconds: 20 },
            {
              screen: "upcoming_matches",
              settings: { count: 3, scope: "division" },
              seconds: 30,
            },
          ],
        },
      }),
    );
  });

  it("deletes a pit group after asking", async () => {
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.click(within(pit).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/52", {
        method: "DELETE",
      }),
    );
  });

  it("copies another session's displays into an empty session and lists those it couldn't place", async () => {
    stub({
      "POST /api/sessions/2/copy-displays": {
        unplaced: [
          {
            device_id: 9,
            device_name: "Lost TV",
            source_group_name: "Field 3",
          },
        ],
      },
    });
    renderRoute();
    await screen.findByRole("option", { name: "Sunday" });
    fireEvent.change(screen.getByLabelText("Session"), {
      target: { value: "2" },
    });
    const copy = await screen.findByRole("region", { name: "Copy displays" });
    fireEvent.change(within(copy).getByLabelText("Copy from"), {
      target: { value: "1" },
    });
    fireEvent.click(within(copy).getByRole("button", { name: "Copy displays" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/2/copy-displays", {
        method: "POST",
        body: { source_session_id: 1 },
      }),
    );
    expect(await screen.findByText("Lost TV (was in Field 3)")).toBeInTheDocument();
  });

  it("shows the server's reason when changing a pit screen is rejected", async () => {
    const base = vi.mocked(apiRequest).getMockImplementation()!;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") throw new ApiError(409, "That screen needs a division");
      return base(path, options as never);
    });
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.change(within(pit).getByLabelText("Screen"), {
      target: { value: "schedule" },
    });
    expect(await within(pit).findByRole("alert")).toHaveTextContent("That screen needs a division");
  });
});
