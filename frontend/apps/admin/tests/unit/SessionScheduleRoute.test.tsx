import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionScheduleRoute } from "../../src/routes/SessionScheduleRoute";
import type { Division, FieldRead, FieldSetRead, MatchRead, SessionRead } from "../../src/types";

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
const ONE_DIVISION: Division[] = [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }];
const TWO_DIVISIONS: Division[] = [
  ...ONE_DIVISION,
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];
const EVENT = {
  id: 1,
  name: "Demo Event",
  active_session_id: 1,
  game_plugin_name: "example-game",
  created_at: "2026-09-01T00:00:00Z",
};
const MATCH_FORMAT = {
  round_types: ["practice", "qualification", "elimination"],
  teams_per_alliance: 2,
  alliance_count: 2,
  match_duration_seconds: 120,
};
const TEAMS = [1, 2, 3, 4].map((id) => ({ id, number: `${id}0${id}`, name: `Team ${id}`, division_id: 1 }));
const PARTICIPANTS = TEAMS.map((team) => ({ id: team.id, session_id: 1, team_id: team.id, checked_in: true }));
const MAIN_SET: FieldSetRead = { id: 10, session_id: 1, name: "Main Fields", division_id: null };
const FIELD_A: FieldRead = { id: 100, field_set_id: 10, name: "Field A" };
const SCHEDULERS = [
  { name: "simple_random", version: "1.0.0", display_name: "Simple random" },
  { name: "balanced", version: "1.0.0", display_name: "Balanced" },
];

function scheduleMatch(overrides: Partial<MatchRead>): MatchRead {
  return {
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
    alliances: [],
    ...overrides,
  };
}

interface StubOptions {
  divisions?: Division[];
  /** A function is re-read on every fetch, for tests where the server's matches change mid-test. */
  matches?: MatchRead[] | (() => MatchRead[]);
  fieldSets?: FieldSetRead[];
  fields?: FieldRead[];
  onWrite?: (path: string, options: { method?: string; body?: unknown }) => unknown;
}

function stub({
  divisions = ONE_DIVISION,
  matches = [],
  fieldSets = [MAIN_SET],
  fields = [FIELD_A],
  onWrite = () => undefined,
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = (options ?? {}) as { method?: string; body?: unknown };
    if (opts.method && opts.method !== "GET") {
      const result = onWrite(path, opts);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/divisions") return divisions as never;
    if (path === "/api/event") return EVENT as never;
    if (path === "/api/event/match-format") return MATCH_FORMAT as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/sessions/1/participants") return PARTICIPANTS as never;
    if (path === "/api/field-sets?session_id=1") return fieldSets as never;
    if (path === "/api/fields?session_id=1") return fields as never;
    if (path === "/api/matches?session_id=1") {
      return (typeof matches === "function" ? matches() : matches) as never;
    }
    if (path === "/api/plugins/schedulers") return SCHEDULERS as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderSchedule() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionScheduleRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function deleteCalls(): string[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === "DELETE")
    .map(([path]) => path as string);
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionScheduleRoute — readiness and rounds", () => {
  it("shows every readiness item as ready and no rounds when nothing is scheduled", async () => {
    stub();
    renderSchedule();

    const checklist = await screen.findByRole("region", { name: "Ready to schedule?" });
    await waitFor(() => expect(within(checklist).getAllByText("Ready")).toHaveLength(4));
    expect(screen.getByText("No rounds have been generated yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Division")).not.toBeInTheDocument();
  });

  it("flags missing fields with a link to the Fields tab", async () => {
    stub({ fields: [] });
    renderSchedule();

    const link = await screen.findByRole("link", { name: "Add fields" });
    expect(link).toHaveAttribute("href", "/sessions/1/fields");
  });

  it("lists rounds for the scope with match and scored counts, leaving out finals", async () => {
    stub({
      matches: [
        scheduleMatch({ id: 1, status: "completed" }),
        scheduleMatch({ id: 2, label: "P2", scheduled_time: "2026-11-07T17:10:00Z" }),
        scheduleMatch({ id: 3, round_type: "elimination", label: "F1", is_finals: true }),
      ],
    });
    renderSchedule();

    const row = await screen.findByRole("row", { name: /practice/ });
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("1")).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /elimination/ })).not.toBeInTheDocument();
  });

  it("requires typing the round name to clear a round with scored matches", async () => {
    stub({ matches: [scheduleMatch({ status: "completed" })] });
    renderSchedule();

    fireEvent.click(await screen.findByRole("button", { name: "Clear practice" }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Type "practice" to confirm'), {
      target: { value: "practice" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=practice"]));
  });

  it("Clear all rounds issues one DELETE per round", async () => {
    stub({
      matches: [
        scheduleMatch({ id: 1 }),
        scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
      ],
    });
    renderSchedule();

    fireEvent.click(await screen.findByRole("button", { name: "Clear all rounds" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(deleteCalls()).toEqual([
        "/api/schedule?session_id=1&round_type=practice",
        "/api/schedule?session_id=1&round_type=qualification",
      ])
    );
  });

  it("in a multi-division event, scopes rounds and the clear request to the selected division", async () => {
    stub({
      divisions: TWO_DIVISIONS,
      fieldSets: [{ ...MAIN_SET, division_id: 2 }],
      matches: [scheduleMatch({ division_id: 2, round_type: "qualification", label: "Q1" })],
    });
    renderSchedule();

    expect(await screen.findByText("No rounds have been generated yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Clear qualification" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=qualification&division_id=2"])
    );
  });
});
