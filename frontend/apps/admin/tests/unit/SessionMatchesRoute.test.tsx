import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionMatchesRoute } from "../../src/routes/SessionMatchesRoute";
import type { MatchRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
};
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: 1 },
  { id: 2, number: "202", name: "Bravo", division_id: 1 },
  { id: 3, number: "303", name: "Charlie", division_id: 1 },
  { id: 4, number: "404", name: "Delta", division_id: 1 },
  { id: 5, number: "505", name: "Echo", division_id: 1 },
  { id: 6, number: "606", name: "Foxtrot", division_id: 1 },
];
const MATCHES: MatchRead[] = [
  {
    id: 2,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: 1,
    label: "Q1",
    field_id: 100,
    time_slot: 1,
    scheduled_time: "2026-11-07T17:10:00Z",
    status: "completed",
    is_finals: false,
    alliances: [
      { id: 3, station: "red", team_ids: [1, 2] },
      { id: 4, station: "blue", team_ids: [5, 6] },
    ],
  },
  {
    id: 1,
    session_id: 1,
    division_id: null,
    round_type: "practice",
    match_number: 1,
    label: "P1",
    field_id: 100,
    time_slot: 0,
    scheduled_time: "2026-11-07T17:00:00Z",
    status: "scheduled",
    is_finals: false,
    alliances: [
      { id: 1, station: "red", team_ids: [1, 2] },
      { id: 2, station: "blue", team_ids: [3, 4] },
    ],
  },
];

function stub(matches: MatchRead[]) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/matches?session_id=1") return matches as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/fields?session_id=1") return [{ id: 100, field_set_id: 10, name: "Field A" }] as never;
    if (path === "/api/divisions") return [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderMatches() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionMatchesRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionMatchesRoute", () => {
  it("lists matches in time order with session-timezone times, field names, and team numbers", async () => {
    stub(MATCHES);
    renderMatches();

    const p1 = await screen.findByRole("gridcell", { name: "P1" });
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toContainElement(p1);
    expect(screen.getByRole("gridcell", { name: "09:00" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell", { name: "Field A" })).toHaveLength(2);
    expect(screen.getByRole("gridcell", { name: "303, 404" })).toBeInTheDocument();
  });

  it("filters by round type and by team search", async () => {
    stub(MATCHES);
    renderMatches();
    await screen.findByRole("gridcell", { name: "P1" });

    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "qualification" } });
    expect(screen.queryByRole("gridcell", { name: "P1" })).not.toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "Q1" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search by team number or name"), { target: { value: "charlie" } });
    expect(screen.getByRole("gridcell", { name: "P1" })).toBeInTheDocument();
    expect(screen.queryByRole("gridcell", { name: "Q1" })).not.toBeInTheDocument();
  });

  it("shows an empty state linking to the Schedule tab", async () => {
    stub([]);
    renderMatches();

    expect(await screen.findByText("No matches yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Schedule" })).toHaveAttribute(
      "href",
      "/sessions/1/schedule"
    );
  });

  it("refetches matches when the session channel reports a new match", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    stub(MATCHES);
    renderMatches();
    await screen.findByRole("gridcell", { name: "P1" });

    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/session/1");
    const matchFetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/matches?session_id=1").length;
    const before = matchFetches();
    act(() => onEvent?.({ event: "new_match_created", data: {} } as RealtimeEvent));
    await waitFor(() => expect(matchFetches()).toBeGreaterThan(before));
  });
});
