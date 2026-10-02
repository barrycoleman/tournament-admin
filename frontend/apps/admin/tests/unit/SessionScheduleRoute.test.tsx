import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n } from "@tournament-admin/shared";
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
  schedulers?: typeof SCHEDULERS;
  /** Request paths that reject with a server error. */
  failPaths?: string[];
  onWrite?: (path: string, options: { method?: string; body?: unknown }) => unknown;
}

function stub({
  divisions = ONE_DIVISION,
  matches = [],
  fieldSets = [MAIN_SET],
  fields = [FIELD_A],
  schedulers = SCHEDULERS,
  failPaths = [],
  onWrite = () => undefined,
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = (options ?? {}) as { method?: string; body?: unknown };
    if (opts.method && opts.method !== "GET") {
      const result = onWrite(path, opts);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (failPaths.includes(path)) throw new ApiError(500, "server exploded");
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
    if (path === "/api/plugins/schedulers") return schedulers as never;
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

function matchFetchCount(): number {
  return vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/matches?session_id=1").length;
}

describe("SessionScheduleRoute — scope changes and failures", () => {
  it("lists a round generated for a division that a single-division event no longer scopes, and clears it in its own scope", async () => {
    stub({ matches: [scheduleMatch({ division_id: 2, round_type: "qualification", label: "Q1" })] });
    renderSchedule();

    const panel = await screen.findByRole("region", { name: "Rounds from a different division setup" });
    expect(within(panel).getByText("Deleted division")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Clear qualification (Deleted division)" }));
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
    fireEvent.click(within(panel).getByRole("button", { name: "Clear practice (No division)" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText('Type "practice" to confirm'), { target: { value: "practice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=practice"]));
  });

  it("shows no out-of-scope panel when every round is in the current scope", async () => {
    stub({ matches: [scheduleMatch({})] });
    renderSchedule();

    await screen.findByRole("row", { name: /practice/ });
    expect(screen.queryByRole("region", { name: "Rounds from a different division setup" })).not.toBeInTheDocument();
  });

  it("does not offer elimination when finals games already use it, and lists no round for them", async () => {
    stub({
      matches: [
        scheduleMatch({ id: 1 }),
        scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
        scheduleMatch({ id: 3, round_type: "elimination", label: "F1", is_finals: true }),
      ],
    });
    renderSchedule();

    expect(await screen.findByText(/Every round type already has a schedule/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Round type for phase 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /elimination/ })).not.toBeInTheDocument();
  });

  it("does not offer elimination in the phase rows when only a finals game exists", async () => {
    stub({ matches: [scheduleMatch({ round_type: "elimination", label: "F1", is_finals: true })] });
    renderSchedule();

    const roundType = await screen.findByLabelText("Round type for phase 1");
    expect(within(roundType).queryByRole("option", { name: "elimination" })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /elimination/ })).not.toBeInTheDocument();
  });

  it("disables Preview and Generate and explains when every round type is scheduled", async () => {
    stub({
      matches: ["practice", "qualification", "elimination"].map((round_type, i) =>
        scheduleMatch({ id: i + 1, round_type, label: `R${i}`, scheduled_time: `2026-11-07T1${i}:00:00Z` })
      ),
    });
    renderSchedule();

    expect(await screen.findByText(/Every round type already has a schedule/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("Clear all keeps the dialog open with the error and refreshes matches after a partial failure", async () => {
    let deletes = 0;
    stub({
      matches: [
        scheduleMatch({ id: 1 }),
        scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
      ],
      onWrite: () => {
        deletes += 1;
        return deletes === 2 ? new ApiError(422, "boom") : undefined;
      },
    });
    renderSchedule();

    fireEvent.click(await screen.findByRole("button", { name: "Clear all rounds" }));
    const before = matchFetchCount();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));

    expect(await within(screen.getByRole("alertdialog")).findByText("boom")).toBeInTheDocument();
    await waitFor(() => expect(matchFetchCount()).toBeGreaterThan(before));
    expect(deleteCalls()).toHaveLength(2);
  });

  it("Clear all with scored matches requires typing the literal phrase", async () => {
    stub({
      matches: [
        scheduleMatch({ id: 1, status: "completed" }),
        scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
      ],
    });
    renderSchedule();

    fireEvent.click(await screen.findByRole("button", { name: "Clear all rounds" }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(/1 of them has a score/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Type "clear all" to confirm'), { target: { value: "clear all" } });
    expect(confirm).toBeEnabled();
  });

  it("shows the generic error, not the plugin hint, when match-format fails with a plugin selected", async () => {
    stub({ failPaths: ["/api/event/match-format"] });
    renderSchedule();

    expect(await screen.findByRole("alert")).toHaveTextContent(enAdmin.errors.generic);
    expect(screen.queryByText("Select a game plugin to set up the schedule.")).not.toBeInTheDocument();
  });

  it("shows the generic error when the divisions fetch fails", async () => {
    stub({ failPaths: ["/api/divisions"] });
    renderSchedule();

    expect(await screen.findByRole("alert")).toHaveTextContent(enAdmin.errors.generic);
  });
});

const PREVIEW_RESPONSE = {
  schedule_generation_id: null,
  match_count: 14,
  resolved_time_blocks: [
    { date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time_seconds: 771.4, time_slot_count: 14 },
  ],
  cycle_time_warning: null,
  phase_results: [
    { round_type: "practice", schedule_generation_id: null, match_count: 2 },
    { round_type: "qualification", schedule_generation_id: null, match_count: 12 },
  ],
};

function scheduleBodies(): unknown[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([path, options]) => path === "/api/schedule" && (options as { method?: string })?.method === "POST")
    .map(([, options]) => (options as { body: unknown }).body);
}

describe("SessionScheduleRoute — generate form", () => {
  it("pre-fills practice x1 then qualification x6 and previews with a fit-mode request", async () => {
    stub({ onWrite: () => PREVIEW_RESPONSE });
    renderSchedule();

    const preview = await screen.findByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);

    await waitFor(() =>
      expect(scheduleBodies()).toEqual([
        {
          session_id: 1,
          scheduler_plugin_name: "balanced",
          phases: [
            { round_type: "practice", target_matches_per_team: 1 },
            { round_type: "qualification", target_matches_per_team: 6 },
          ],
          time_blocks: [{ date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time: null }],
          dry_run: true,
        },
      ])
    );
    const panel = await screen.findByRole("region", { name: "Preview" });
    expect(within(panel).getByText("practice: 2 matches")).toBeInTheDocument();
    expect(within(panel).getByText("12:51")).toBeInTheDocument();
  });

  it("uses the singular for a one-match phase in the preview", async () => {
    stub({
      onWrite: () => ({
        ...PREVIEW_RESPONSE,
        match_count: 1,
        phase_results: [{ round_type: "practice", schedule_generation_id: null, match_count: 1 }],
      }),
    });
    renderSchedule();

    const preview = await screen.findByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);

    const panel = await screen.findByRole("region", { name: "Preview" });
    expect(within(panel).getByText("practice: 1 match")).toBeInTheDocument();
  });

  it("does not offer round types that already have a schedule", async () => {
    stub({ matches: [scheduleMatch({})] });
    renderSchedule();

    const roundType = await screen.findByLabelText("Round type for phase 1");
    expect((roundType as HTMLSelectElement).value).toBe("qualification");
    expect(within(roundType).queryByRole("option", { name: "practice" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Round type for phase 2")).not.toBeInTheDocument();
  });

  it("fixed cycle mode sends cycle_time on every block and allows an open-ended last block", async () => {
    stub({ onWrite: () => PREVIEW_RESPONSE });
    renderSchedule();

    fireEvent.click(await screen.findByLabelText("Fixed cycle time"));
    fireEvent.change(screen.getByLabelText("Cycle time (minutes)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("End time for block 1"), { target: { value: "" } });
    const preview = screen.getByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);

    await waitFor(() =>
      expect((scheduleBodies()[0] as { time_blocks: unknown }).time_blocks).toEqual([
        { date: "2026-11-07", start_time: "09:00", end_time: null, cycle_time: 480 },
      ])
    );
  });

  it("marks the preview out of date once an input changes", async () => {
    stub({ onWrite: () => PREVIEW_RESPONSE });
    renderSchedule();

    const preview = await screen.findByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    await screen.findByRole("region", { name: "Preview" });
    expect(screen.queryByText("Out of date — preview again")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Matches per team for phase 2"), { target: { value: "4" } });
    expect(screen.getByText("Out of date — preview again")).toBeInTheDocument();
  });

  it("shows a server rejection verbatim", async () => {
    stub({ onWrite: () => new ApiError(422, "round_type 'qualification': Scheduler plugin returned no matches") });
    renderSchedule();

    const generate = await screen.findByRole("button", { name: "Generate" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "round_type 'qualification': Scheduler plugin returned no matches"
    );
  });

  it("keeps Preview and Generate disabled until every readiness item passes", async () => {
    stub({ fields: [] });
    renderSchedule();

    await screen.findByRole("link", { name: "Add fields" });
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("after Generate, links to Matches and stops offering the generated round types", async () => {
    let generated = false;
    stub({
      matches: () =>
        generated
          ? [
              scheduleMatch({ id: 1 }),
              scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
            ]
          : [],
      onWrite: () => {
        generated = true;
        return { ...PREVIEW_RESPONSE, schedule_generation_id: 7 };
      },
    });
    renderSchedule();

    const generate = await screen.findByRole("button", { name: "Generate" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    expect(await screen.findByText("Generated 14 matches.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View matches" })).toHaveAttribute("href", "/sessions/1/matches");
    const roundType = await screen.findByLabelText("Round type for phase 1");
    await waitFor(() => expect((roundType as HTMLSelectElement).value).toBe("elimination"));
  });

  it("disables Preview and Generate when no scheduler plugin is installed", async () => {
    stub({ schedulers: [] });
    renderSchedule();

    expect(await screen.findByText("No scheduler plugin is installed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("does not allow removing the only phase row", async () => {
    stub({ matches: [scheduleMatch({})] });
    renderSchedule();

    await screen.findByLabelText("Round type for phase 1");
    expect(screen.getByRole("button", { name: "Remove phase" })).toBeDisabled();
  });
});
