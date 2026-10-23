import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionDetailLayout } from "../../src/routes/SessionDetailLayout";
import { SessionTodayRoute } from "../../src/routes/SessionTodayRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const mock = vi.mocked(apiRequest);

const SESSION = { id: 1, event_id: 1, label: "Saturday", session_date: "2026-09-05", timezone: "America/Los_Angeles" };
const FORMAT = { round_types: ["qualification"], teams_per_alliance: 2, alliance_count: 2, match_duration_seconds: 150, default_cycle_time_seconds: null };

interface World {
  activeId?: number | null;
  plugin?: string | null;
  timezone?: string | null;
  teamCount?: number;
  checkedIn?: number;
  windows?: number;
  divisions?: { id: number; name: string }[];
  fieldSets?: unknown[];
  fields?: unknown[];
  matches?: unknown[];
  displays?: number;
}

function teamsOf(n: number, divisionIds: (number | null)[] = [null]) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, number: String(i + 1), name: `T${i + 1}`, division_id: divisionIds[i % divisionIds.length] }));
}

function stub(w: World = {}) {
  const teamCount = w.teamCount ?? 24;
  const divisions = w.divisions ?? [{ id: 1, name: "Main" }];
  const multi = divisions.length > 1;
  const session = { ...SESSION, timezone: w.timezone === undefined ? SESSION.timezone : w.timezone };
  mock.mockImplementation(async (path: string) => {
    const routes: Record<string, unknown> = {
      "/api/event": { id: 1, name: "E", active_session_id: w.activeId ?? null, game_plugin_name: w.plugin === undefined ? "game" : w.plugin },
      "/api/sessions": [session],
      "/api/divisions": divisions,
      "/api/teams": teamsOf(teamCount, multi ? divisions.map((d) => d.id) : [null]),
      "/api/sessions/1/participants": Array.from({ length: w.checkedIn ?? 18 }, (_, i) => ({ id: i, session_id: 1, team_id: i + 1, checked_in: true })),
      "/api/field-sets?session_id=1": w.fieldSets ?? [],
      "/api/fields?session_id=1": w.fields ?? [],
      "/api/sessions/1/playing-windows": Array.from({ length: w.windows ?? 0 }, () => ({})),
      "/api/event/match-format": FORMAT,
      "/api/matches?session_id=1": w.matches ?? [],
      "/api/displays?session_id=1": {
        session_id: 1,
        has_setup: true,
        unassigned: [],
        groups: (w.displays ?? 0) > 0 ? [{ id: 1, displays: Array.from({ length: w.displays! }, (_, i) => ({ device_id: i, name: "d", online: true })) }] : [],
      },
      "/api/skills/settings": { enabled: false, attempts: {}, types: [] },
    };
    if (path in routes) return routes[path] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

const readyFieldSet = [{ id: 1, session_id: 1, name: "FS", purpose: "teamwork", division_id: null }];
const readyField = [{ id: 1, field_set_id: 1, name: "F1" }];
const readyMatch = [{ id: 1, session_id: 1, division_id: null, is_finals: false, alliances: [] }];

function renderAt(path: string) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/sessions/:sessionId",
        element: <SessionDetailLayout />,
        children: [
          { path: "today", element: <SessionTodayRoute /> },
          { path: "setup", element: <p>setup</p> },
        ],
      },
    ],
    { initialEntries: [path] }
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
  mock.mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionTodayRoute", () => {
  it("shows 'Set up the session' for a fresh session", async () => {
    stub({ timezone: null });
    renderAt("/sessions/1/today");
    const link = await screen.findByRole("link", { name: "Set up the session" });
    expect(link).toHaveAttribute("href", "/sessions/1/setup");
    expect(link).toHaveClass("btn-primary");
  });

  it("renders the check-in count, progress bar and a primary button while teams are short", async () => {
    stub({ teamCount: 24, checkedIn: 18 });
    renderAt("/sessions/1/today");
    expect(await screen.findByText("18 / 24 checked in")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "18");
    expect(screen.getByRole("link", { name: "Check teams in" })).toHaveAttribute("href", "/sessions/1/checkin");
  });

  it("offers Make active when everything but active is ready, and the click opens the dialog", async () => {
    stub({ activeId: 2, windows: 1, fieldSets: readyFieldSet, fields: readyField, matches: readyMatch });
    renderAt("/sessions/1/today");
    const card = (await screen.findByRole("heading", { name: "Matches", level: 2 })).closest("section")!;
    const button = within(card).getByRole("button", { name: "Make active" });
    expect(button).toHaveClass("btn-primary");
    // The check-in button is no longer primary once the teams are in.
    expect(screen.getByRole("link", { name: "Check teams in" })).not.toHaveClass("btn-primary");
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Make Saturday active?" })).toBeInTheDocument();
  });

  it("links to Match Control once everything is ready", async () => {
    stub({ activeId: 1, windows: 1, fieldSets: readyFieldSet, fields: readyField, matches: readyMatch, displays: 1 });
    renderAt("/sessions/1/today");
    const link = await screen.findByRole("link", { name: "Go to Match Control" });
    expect(link).toHaveAttribute("href", "/match-control");
  });

  it("marks fields not done in a multi-division event when one division has none", async () => {
    stub({
      divisions: [{ id: 1, name: "A" }, { id: 2, name: "B" }],
      fieldSets: [{ id: 1, session_id: 1, name: "FS", purpose: "teamwork", division_id: 1 }],
      fields: readyField,
    });
    renderAt("/sessions/1/today");
    const row = (await screen.findByRole("link", { name: "Every division has fields" })).closest("li")!;
    expect(within(row).getByRole("img", { name: "Not done" })).toBeInTheDocument();
  });

  it("lists failing event setup items as a warning with links", async () => {
    stub({ plugin: null });
    renderAt("/sessions/1/today");
    const alert = await screen.findByText("Finish setting up the event first:");
    const link = within(alert.closest(".alert-warning") as HTMLElement).getByRole("link", { name: "Select a game plugin" });
    expect(link).toHaveAttribute("href", "/events/setup");
  });

  it("shows the reserved inspection card", async () => {
    stub();
    renderAt("/sessions/1/today");
    expect(await screen.findByText(/Inspection status will appear here/)).toBeInTheDocument();
  });
});

describe("SessionDetailLayout tabs", () => {
  it("renders the tabs in the new order with no Fields tab, and Today is active", async () => {
    stub();
    renderAt("/sessions/1/today");
    await screen.findByRole("heading", { name: "Saturday" });
    const nav = screen.getByRole("navigation");
    const names = within(nav).getAllByRole("link").map((l) => l.textContent);
    expect(names).toEqual(["Today", "Setup", "Check-In", "Schedule", "Matches", "Rankings", "Awards"]);
    expect(within(nav).getByRole("link", { name: "Today" })).toHaveClass("active");
  });
});
