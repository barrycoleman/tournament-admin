import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionScheduleRoute } from "../../src/routes/SessionScheduleRoute";
import type { PlanRequest } from "../../src/schedule/planDraft";
import type {
  Division,
  FieldRead,
  FieldSetRead,
  MatchRead,
  PlanResponse,
  ScheduledRound,
  SessionRead,
} from "../../src/types";

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
  default_cycle_time_seconds: null,
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

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

const WINDOWS = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: "2026-11-07T17:00:00Z", end_utc: "2026-11-07T20:00:00Z" },
];

function round(overrides: Partial<ScheduledRound>): ScheduledRound {
  return {
    round_type: "practice",
    target_matches_per_team: 1,
    cycle_time_seconds: 420,
    match_count: 2,
    scored_count: 0,
    first_start: "2026-11-07T17:00:00Z",
    last_end: "2026-11-07T17:09:00Z",
    locked: false,
    outside_playing_windows: false,
    ...overrides,
  };
}

const FITS: PlanResponse = {
  fits: true,
  rounds: [
    { round_type: "practice", schedule_generation_id: null, match_count: 2, slot_count: 1, first_start: "2026-11-07T17:00:00Z", last_end: "2026-11-07T17:02:00Z" },
    { round_type: "qualification", schedule_generation_id: null, match_count: 12, slot_count: 6, first_start: "2026-11-07T17:03:00Z", last_end: "2026-11-07T17:40:00Z" },
  ],
  overflow: null,
};

const OVER: PlanResponse = {
  fits: false,
  rounds: [{ round_type: "qualification", schedule_generation_id: null, match_count: 16, slot_count: 8, first_start: "2026-11-07T17:12:00Z", last_end: null }],
  overflow: { unplaced_slot_count: 2, unplaced_match_count: 3, over_by_seconds: 960, suggested_cycle_time_seconds: 410, suggested_last_window_end: "12:16" },
};

interface StubOptions {
  divisions?: Division[];
  windows?: typeof WINDOWS;
  rounds?: ScheduledRound[] | (() => ScheduledRound[]);
  fields?: FieldRead[];
  matches?: MatchRead[];
  plan?: (body: PlanRequest) => PlanResponse | Error;
  onWrite?: (path: string, options: { method?: string; body?: unknown }) => unknown;
}

function stub({
  divisions = ONE_DIVISION,
  windows = WINDOWS,
  rounds = [],
  fields = [FIELD_A],
  matches = [],
  plan = () => FITS,
  onWrite = () => undefined,
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = (options ?? {}) as { method?: string; body?: unknown };
    if (path === "/api/schedule" && opts.method === "POST") {
      const body = opts.body as PlanRequest;
      if (!body.dry_run) {
        const written = onWrite(path, opts);
        if (written instanceof Error) throw written;
        return (written ?? FITS) as never;
      }
      const result = plan(body);
      if (result instanceof Error) throw result;
      return result as never;
    }
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
    if (path === "/api/field-sets?session_id=1") return [MAIN_SET] as never;
    if (path === "/api/fields?session_id=1") return fields as never;
    if (path === "/api/matches?session_id=1") return matches as never;
    if (path === "/api/plugins/schedulers") return SCHEDULERS as never;
    if (path === "/api/sessions/1/playing-windows") return windows as never;
    if (path.startsWith("/api/schedule/rounds?session_id=1")) {
      return { rounds: typeof rounds === "function" ? rounds() : rounds, session_last_cycle_time_seconds: null } as never;
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderSchedule() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    {
      path: "/",
      element: <SessionOutlet />,
      children: [
        { index: true, element: <SessionScheduleRoute /> },
        { path: "elsewhere", element: <p>Elsewhere</p> },
      ],
    },
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  return { router, queryClient };
}

function dryRuns(): PlanRequest[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([path, options]) => path === "/api/schedule" && (options as { body?: PlanRequest })?.body?.dry_run)
    .map(([, options]) => (options as { body: PlanRequest }).body);
}

describe("SessionScheduleRoute — planning", () => {
  it("pre-fills Practice and Qualification with the fallback cycle time and checks the plan", async () => {
    stub();
    renderSchedule();
    expect(await screen.findByLabelText("Practice matches per team")).toHaveValue(1);
    expect(screen.getByLabelText("Qualification matches per team")).toHaveValue(6);
    expect(screen.getByLabelText("Practice cycle time minutes")).toHaveValue(4);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    expect(dryRuns().at(-1)).toEqual({
      session_id: 1,
      scheduler_plugin_name: "balanced",
      rounds: [
        { round_type: "practice", target_matches_per_team: 1, cycle_time_seconds: 240 },
        { round_type: "qualification", target_matches_per_team: 6, cycle_time_seconds: 240 },
      ],
      dry_run: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Fits, with 2 h 20 min of Sat still free.");
  });

  it("shows no tabs in a single-division event", async () => {
    stub();
    renderSchedule();
    await screen.findByLabelText("Practice matches per team");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("generates the plan and links to the matches", async () => {
    const writes: PlanRequest[] = [];
    stub({ onWrite: (_path, options) => void writes.push(options.body as PlanRequest) });
    renderSchedule();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].dry_run).toBe(false);
    expect(await screen.findByText(/14 matches scheduled\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View matches" })).toHaveAttribute("href", "/sessions/1/matches");
  });

  it("marks an edited round as changed and sends it with every round after it", async () => {
    stub({ rounds: [round({}), round({ round_type: "qualification", target_matches_per_team: 6 })] });
    renderSchedule();
    const practice = await screen.findByLabelText("Practice matches per team");
    expect(screen.queryByRole("button", { name: /Apply changes|Generate/ })).toBeDisabled();
    fireEvent.change(practice, { target: { value: "2" } });
    expect(screen.getByText("changed")).toBeInTheDocument();
    expect(screen.getByText("was 1")).toBeInTheDocument();
    expect(screen.getByText("Rebuilds Practice, Qualification.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
    expect(dryRuns().at(-1)?.rounds.map((r) => r.round_type)).toEqual(["practice", "qualification"]);
  });

  it("explains an overflow and applies the suggested cycle time", async () => {
    stub({
      rounds: [round({ round_type: "qualification", target_matches_per_team: 6 })],
      plan: (body) => (body.rounds[0].cycle_time_seconds === 410 ? FITS : OVER),
    });
    renderSchedule();
    fireEvent.change(await screen.findByLabelText("Qualification matches per team"), { target: { value: "8" } });
    expect(await screen.findByText(/Over by 16 min: 3 Qualification matches don't fit before Sat 12:00\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use cycle time 6:50" }));
    expect(screen.getByLabelText("Qualification cycle time minutes")).toHaveValue(6);
    expect(screen.getByLabelText("Qualification cycle time seconds")).toHaveValue(50);
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
  });

  it("re-checks the plan after Extend", async () => {
    let extended = false;
    stub({
      rounds: [round({ round_type: "qualification", target_matches_per_team: 6 })],
      plan: () => (extended ? FITS : OVER),
      onWrite: (path) => {
        if (path === "/api/sessions/1/playing-windows") extended = true;
        return [];
      },
    });
    renderSchedule();
    fireEvent.change(await screen.findByLabelText("Qualification matches per team"), { target: { value: "8" } });
    fireEvent.click(await screen.findByRole("button", { name: "Extend Sat to 12:16" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
  });

  it("locks a scored round and only offers Clear", async () => {
    stub({ rounds: [round({ locked: true, scored_count: 1 }), round({ round_type: "qualification" })] });
    renderSchedule();
    await screen.findByLabelText("Qualification matches per team");
    expect(screen.queryByLabelText("Practice matches per team")).not.toBeInTheDocument();
    expect(screen.getByText(/1 scored/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Practice" })).toBeInTheDocument();
  });

  it("requires typing the round name to clear a round with scored matches", async () => {
    stub({ rounds: [round({ locked: true, scored_count: 1 })], onWrite: () => ({ matches_deleted: 2 }) });
    renderSchedule();
    fireEvent.click(await screen.findByRole("button", { name: "Clear Practice" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Clear" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type "Practice" to confirm'), { target: { value: "Practice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/schedule?session_id=1&round_type=practice", { method: "DELETE" })
    );
  });

  it("asks before leaving with unapplied changes", async () => {
    stub({ rounds: [round({})] });
    const { router } = renderSchedule();
    fireEvent.change(await screen.findByLabelText("Practice matches per team"), { target: { value: "3" } });
    await act(() => router.navigate("/elsewhere"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByLabelText("Practice matches per team")).toHaveValue(3);
  });
});

describe("SessionScheduleRoute — readiness and divisions", () => {
  it("lists a missing playing time as a blocker, with the editor open", async () => {
    stub({ windows: [] });
    renderSchedule();
    const blockers = await screen.findByRole("region", { name: "Can't schedule yet" });
    expect(within(blockers).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "This session has no playing times. Add playing times",
    ]);
    expect(screen.getByLabelText("Playing time 1 date")).toHaveValue("2026-11-07");
  });

  it("lists only what blocks scheduling, each with a link to fix it", async () => {
    stub({ fields: [] });
    renderSchedule();
    const blockers = await screen.findByRole("region", { name: "Can't schedule yet" });
    expect(within(blockers).getByRole("link", { name: "Add fields" })).toHaveAttribute("href", "/sessions/1/fields");
  });

  it("shows a tab per division with its team count, and scopes requests to the selected one", async () => {
    stub({ divisions: TWO_DIVISIONS });
    renderSchedule();
    expect(await screen.findByRole("tab", { name: "Division 1 · 4 teams" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Blue · 0 teams" }));
    await waitFor(() =>
      expect(vi.mocked(apiRequest).mock.calls.some(([path]) => path === "/api/schedule/rounds?session_id=1&division_id=2")).toBe(true)
    );
  });

  it("asks before switching division with unapplied changes", async () => {
    stub({ divisions: TWO_DIVISIONS, rounds: [round({})] });
    renderSchedule();
    fireEvent.change(await screen.findByLabelText("Practice matches per team"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("tab", { name: "Blue · 0 teams" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { name: "Division 1 · 4 teams" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the generic error when the divisions fetch fails", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(500, "boom"));
    renderSchedule();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  });
});

function deleteCalls(): string[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === "DELETE")
    .map(([path]) => path as string);
}

describe("SessionScheduleRoute — out-of-scope rounds", () => {
  it("lists a round generated for a division that a single-division event no longer scopes, and clears it in its own scope", async () => {
    stub({ matches: [scheduleMatch({ division_id: 2, round_type: "qualification", label: "Q1" })] });
    renderSchedule();

    const panel = await screen.findByRole("region", { name: "Rounds from a different division setup" });
    expect(within(panel).getByText("Deleted division")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Clear Qualification (Deleted division)" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=qualification&division_id=2"])
    );
  });

  it("lists a no-division round in a multi-division event and clears it without a division_id", async () => {
    stub({
      divisions: TWO_DIVISIONS,
      matches: [scheduleMatch({ division_id: null, status: "completed" })],
    });
    renderSchedule();

    const panel = await screen.findByRole("region", { name: "Rounds from a different division setup" });
    expect(within(panel).getByText("No division")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Clear Practice (No division)" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText('Type "Practice" to confirm'), { target: { value: "Practice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=practice"]));
  });

  it("shows no out-of-scope panel when every round is in the current scope", async () => {
    stub({ matches: [scheduleMatch({})] });
    renderSchedule();

    await screen.findByLabelText("Practice matches per team");
    expect(screen.queryByRole("region", { name: "Rounds from a different division setup" })).not.toBeInTheDocument();
  });
});
