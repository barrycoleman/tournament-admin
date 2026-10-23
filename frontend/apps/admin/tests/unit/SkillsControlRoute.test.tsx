import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SkillsControlRoute } from "../../src/routes/SkillsControlRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    apiRequest: vi.fn(),
    useRealtimeChannel: vi.fn(),
    // The panel itself is Task 13's and has its own tests; here it only has to open for the right field.
    SkillsRunPanel: ({ fieldId }: { fieldId: number }) => <p>{`Run panel for field ${fieldId}`}</p>,
  };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

const TEAMS = [
  { id: 1, number: "11A", name: "Alpha", division_id: null },
  { id: 2, number: "22B", name: "Bravo", division_id: null },
  { id: 3, number: "33C", name: "Charlie", division_id: null },
  { id: 4, number: "44D", name: "Delta", division_id: null },
  { id: 5, number: "55E", name: "Echo", division_id: null },
];
// Delta is not checked in.
const PARTICIPANTS = [1, 2, 3, 5].map((teamId) => ({ id: teamId, session_id: 1, team_id: teamId, checked_in: true }));
const MAIN = { id: 10, session_id: 1, name: "Main Fields", division_id: null, purpose: "teamwork" };
const ROW = { id: 20, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, field_id: 31, field_set_id: 20, team_id: 1, team_number: "11A", team_name: "Alpha",
    skills_type: "autonomous", data: {}, item_meta: {}, version: 1, score: 0, follows_set: true,
    phase: "ready", deadline: null, paused: false, remaining_seconds: null, ...overrides,
  };
}

function attempt(overrides: Record<string, unknown>) {
  return {
    id: 1, team_id: 3, skills_type: "autonomous", number: 1, score: 20, data: {}, recorded_at: "", updated_at: "",
    field_id: null, ...overrides,
  };
}

let event: { active_session_id: number | null };
let fieldSets: Record<string, unknown>[];
let skillsSet: { timer: Record<string, unknown>; fields: Record<string, unknown>[] };
let attempts: Record<string, unknown>[];

function stub(extra: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    const routes: Record<string, unknown> = {
      "GET /api/event": { id: 1, name: "E", game_plugin_name: "g", game_plugin_locked: false, created_at: "", ...event },
      "GET /api/field-sets?session_id=1": fieldSets,
      "GET /api/field-sets/20/skills": skillsSet,
      "GET /api/skills/settings": {
        enabled: true,
        attempts: {},
        types: [
          { key: "autonomous", label: "Autonomous", run_seconds: 60 },
          { key: "driver", label: "Driver", run_seconds: 60 },
        ],
      },
      "GET /api/sessions/1/skills": {
        types: [
          { key: "autonomous", label: "Autonomous", allowed: 1 },
          { key: "driver", label: "Driver", allowed: 3 },
        ],
        override: null,
      },
      "GET /api/sessions/1/skills/attempts": attempts,
      "GET /api/teams": TEAMS,
      "GET /api/sessions/1/participants": PARTICIPANTS,
      ...extra,
    };
    if (key in routes) {
      const value = routes[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (options?.method && options.method !== "GET") return {} as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SkillsControlRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const card = () => screen.findByRole("region", { name: "Skills Row" });
const gets = (path: string) =>
  vi.mocked(apiRequest).mock.calls.filter(([p, options]) => p === path && !(options as { method?: string } | undefined)?.method)
    .length;

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
  event = { active_session_id: 1 };
  fieldSets = [MAIN, ROW];
  skillsSet = {
    timer: { field_set_id: 20, skills_type: "autonomous", phase: "ready", deadline: null, paused: false, remaining_seconds: null, run_seconds: 60 },
    fields: [
      { field_id: 31, name: "Skills 1", run: run() },
      { field_id: 32, name: "Skills 2", run: null },
      {
        field_id: 33,
        name: "Skills 3",
        run: run({ id: 3, field_id: 33, team_id: 5, team_number: "55E", team_name: "Echo", follows_set: false, phase: "running", deadline: inSeconds(45) }),
      },
    ],
  };
  // Charlie has used its only autonomous attempt.
  attempts = [attempt({})];
  stub();
});

describe("Skills Control", () => {
  it("asks for an active session when there is none", async () => {
    event = { active_session_id: null };
    stub();
    renderRoute();
    expect(await screen.findByText(/No session is active/)).toBeInTheDocument();
  });

  it("points to the Fields page when the session has no skills field set", async () => {
    fieldSets = [MAIN];
    stub();
    renderRoute();
    expect(await screen.findByRole("link", { name: "Fields page." })).toHaveAttribute("href", "/sessions/1/setup#fields");
  });

  it("shows each skills set with its type, its timer and a row per field", async () => {
    renderRoute();
    const set = await card();
    expect(within(set).getByLabelText("Skills type")).toHaveValue("autonomous");
    expect(within(set).getByLabelText("Skills type")).toBeDisabled();
    expect(within(set).getByTestId("set-clock-20")).toHaveTextContent("1:00");
    const one = within(set).getByRole("row", { name: "Skills 1" });
    expect(one).toHaveTextContent("11A Alpha");
    expect(one).toHaveTextContent("Autonomous");
    expect(one).toHaveTextContent("Set timer");
    expect(one).toHaveTextContent("Ready");
    const two = within(set).getByRole("row", { name: "Skills 2" });
    expect(two).toHaveTextContent("No run");
    expect(within(two).getByRole("button", { name: "Start run" })).toBeInTheDocument();
    const three = within(set).getByRole("row", { name: "Skills 3" });
    expect(three).toHaveTextContent(/Alone · 0:4[45]/);
    expect(three).toHaveTextContent("Running");
    expect(screen.queryByRole("region", { name: "Main Fields" })).not.toBeInTheDocument();
  });

  it("runs the set timer, and changes the set's type once no run is left", async () => {
    renderRoute();
    const set = await card();
    fireEvent.click(within(within(set).getByRole("group", { name: "Set timer" })).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/20/skills-timer/start", { method: "POST" }));

    cleanup();
    skillsSet = { ...skillsSet, fields: skillsSet.fields.map((field) => ({ ...field, run: null })) };
    stub();
    renderRoute();
    const select = within(await card()).getByLabelText("Skills type");
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: "driver" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/20/skills-timer", { method: "PUT", body: { skills_type: "driver" } })
    );
  });

  it("starts a run with a checked-in team that is free and has an attempt left", async () => {
    renderRoute();
    const two = within(await card()).getByRole("row", { name: "Skills 2" });
    fireEvent.click(within(two).getByRole("button", { name: "Start run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a run on Skills 2" });
    const team = within(dialog).getByLabelText("Team");
    await waitFor(() =>
      expect(within(team).getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose a team…", "22B Bravo"])
    );
    fireEvent.change(team, { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields/32/skills-run", {
        method: "POST",
        body: { team_id: 2, skills_type: "autonomous", follows_set: true },
      })
    );
  });

  it("starts a run of another type on the field's own timer", async () => {
    renderRoute();
    fireEvent.click(within(within(await card()).getByRole("row", { name: "Skills 2" })).getByRole("button", { name: "Start run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a run on Skills 2" });
    fireEvent.change(within(dialog).getByLabelText("Skills type"), { target: { value: "driver" } });
    expect(within(dialog).getByText(/runs on this field's own timer/)).toBeInTheDocument();
    const team = within(dialog).getByLabelText("Team");
    await waitFor(() =>
      expect(within(team).getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Choose a team…",
        "22B Bravo",
        "33C Charlie",
      ])
    );
    fireEvent.change(team, { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields/32/skills-run", {
        method: "POST",
        body: { team_id: 3, skills_type: "driver", follows_set: false },
      })
    );
  });

  it("moves a field's own timer, and discards a run after asking", async () => {
    renderRoute();
    const set = await card();
    const three = within(set).getByRole("row", { name: "Skills 3" });
    fireEvent.click(within(within(three).getByRole("group", { name: "Timer for Skills 3" })).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/fields/33/skills-run/pause", { method: "POST" }));

    fireEvent.click(within(within(set).getByRole("row", { name: "Skills 1" })).getByRole("button", { name: "Discard" }));
    const dialog = screen.getByRole("alertdialog", { name: "Discard the run on Skills 1?" });
    expect(dialog).toHaveTextContent("Team 11A's entries are thrown away and no attempt is used.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard run" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/fields/31/skills-run", { method: "DELETE" }));
  });

  it("asks before ending or resetting the set timer, naming how many fields it moves", async () => {
    skillsSet.timer = { ...skillsSet.timer, phase: "running", deadline: inSeconds(30) };
    skillsSet.fields[1] = {
      field_id: 32,
      name: "Skills 2",
      run: run({ id: 2, field_id: 32, team_id: 2, team_number: "22B", team_name: "Bravo", phase: "running", deadline: inSeconds(30) }),
    };
    renderRoute();
    const timer = within(await card()).getByRole("group", { name: "Set timer" });

    fireEvent.click(within(timer).getByRole("button", { name: "End" }));
    let dialog = screen.getByRole("alertdialog", { name: "End the set timer on Skills Row?" });
    // Skills 1 and Skills 2 follow the set; Skills 3 runs on its own timer.
    expect(dialog).toHaveTextContent("Fields affected: 2");
    expect(apiRequest).not.toHaveBeenCalledWith("/api/field-sets/20/skills-timer/end", { method: "POST" });
    fireEvent.click(within(dialog).getByRole("button", { name: "End timer" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/20/skills-timer/end", { method: "POST" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    fireEvent.click(within(timer).getByRole("button", { name: "Reset" }));
    dialog = screen.getByRole("alertdialog", { name: "Reset the set timer on Skills Row?" });
    expect(dialog).toHaveTextContent("Fields affected: 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalledWith("/api/field-sets/20/skills-timer/reset", { method: "POST" });
  });

  it("asks before ending or resetting a field's own timer", async () => {
    renderRoute();
    const three = within(await card()).getByRole("row", { name: "Skills 3" });
    const timer = within(three).getByRole("group", { name: "Timer for Skills 3" });

    fireEvent.click(within(timer).getByRole("button", { name: "End" }));
    let dialog = screen.getByRole("alertdialog", { name: "End the timer on Skills 3?" });
    expect(dialog).toHaveTextContent("Team 55E's run ends now.");
    expect(apiRequest).not.toHaveBeenCalledWith("/api/fields/33/skills-run/end", { method: "POST" });
    fireEvent.click(within(dialog).getByRole("button", { name: "End timer" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/fields/33/skills-run/end", { method: "POST" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    fireEvent.click(within(timer).getByRole("button", { name: "Reset" }));
    dialog = screen.getByRole("alertdialog", { name: "Reset the timer on Skills 3?" });
    expect(dialog).toHaveTextContent("Team 55E's timer goes back to the start. Its entries are kept.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset timer" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/fields/33/skills-run/reset", { method: "POST" }));
  });

  it("opens the scoring panel for a field's run", async () => {
    renderRoute();
    fireEvent.click(within(within(await card()).getByRole("row", { name: "Skills 1" })).getByRole("button", { name: "Score" }));
    const dialog = screen.getByRole("alertdialog", { name: "Score Skills 1" });
    expect(within(dialog).getByText("Run panel for field 31")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows a field's last submitted attempt once its run is gone", async () => {
    attempts = [attempt({}), attempt({ id: 7, team_id: 2, score: 40, field_id: 32 })];
    stub();
    renderRoute();
    const two = within(await card()).getByRole("row", { name: "Skills 2" });
    expect(two).toHaveTextContent("Submitted");
    expect(two).toHaveTextContent("Last: 22B · 40");
  });

  it("shows the server's message when an action is refused", async () => {
    stub({ "POST /api/field-sets/20/skills-timer/start": new ApiError(409, "No run is following this field set.") });
    renderRoute();
    const set = await card();
    fireEvent.click(within(within(set).getByRole("group", { name: "Set timer" })).getByRole("button", { name: "Start" }));
    expect(await within(set).findByRole("alert")).toHaveTextContent("No run is following this field set.");
  });

  it("refetches a set when its runs change", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    renderRoute();
    await card();
    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    const before = gets("/api/field-sets/20/skills");
    act(() => onEvent?.({ event: "skills_run_changed", data: { field_set_id: 20, field_id: 31 } }));
    await waitFor(() => expect(gets("/api/field-sets/20/skills")).toBeGreaterThan(before));
  });
});
