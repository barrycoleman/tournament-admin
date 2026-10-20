import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n, type LiveMatch, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { MatchControlRoute } from "../../src/routes/MatchControlRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
function match(overrides: Partial<LiveMatch>): LiveMatch {
  const id = overrides.id ?? 1;
  return {
    id, session_id: 1, division_id: null, round_type: "qualification", match_number: id, label: `Q${id}`,
    field_id: 1, scheduled_time: soon(id), status: "scheduled", phase: "not_started", phase_deadline: null,
    paused: false, remaining_seconds_at_pause: null, is_finals: false,
    alliances: [
      { id: id * 10 + 1, station: "red", team_ids: [1] },
      { id: id * 10 + 2, station: "blue", team_ids: [2] },
    ],
    ...overrides,
  };
}

let event: { active_session_id: number | null };
let fieldSets: Record<string, unknown>[];
let matches: LiveMatch[];
let scores: Record<string, unknown>[];
let audience: Record<string, unknown>;
let sessions: Record<string, unknown>[];

function stub() {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    const routes: Record<string, unknown> = {
      "GET /api/event": { id: 1, name: "E", game_plugin_name: "g", game_plugin_locked: false, created_at: "", ...event },
      "GET /api/sessions": sessions,
      "GET /api/field-sets?session_id=1": fieldSets,
      "GET /api/fields?session_id=1": [
        { id: 1, field_set_id: 10, name: "Field 1" },
        { id: 2, field_set_id: 10, name: "Field 2" },
        { id: 3, field_set_id: 11, name: "Side 1" },
      ],
      "GET /api/matches?session_id=1": matches,
      "GET /api/scores?session_id=1": scores,
      "GET /api/teams": [
        { id: 1, number: "101A", name: "Rockets", division_id: null },
        { id: 2, number: "102B", name: "Gears", division_id: null },
      ],
      "GET /api/displays?session_id=1": { session_id: 1, groups: [audience], unassigned: [], has_setup: false },
    };
    if (key in routes) return routes[key] as never;
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
          <MatchControlRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  localStorage.clear();
  event = { active_session_id: 1 };
  fieldSets = [
    { id: 10, session_id: 1, name: "Main Fields", division_id: null, queued_match_id: null, timeout_deadline: null, purpose: "teamwork" },
    { id: 11, session_id: 1, name: "Side Fields", division_id: null, queued_match_id: null, timeout_deadline: null, purpose: "teamwork" },
    { id: 12, session_id: 1, name: "Skills Row", division_id: null, queued_match_id: null, timeout_deadline: null, purpose: "skills" },
  ];
  matches = [match({ id: 1 }), match({ id: 2, field_id: 2 }), match({ id: 3, field_id: 3 })];
  scores = [];
  audience = {
    id: 50, session_id: 1, kind: "audience", name: "Main Fields", field_set_id: 10, field_id: null, division_id: null,
    screen: "logo", screen_settings: {}, rotation: null, play_sounds: false, displays: [],
  };
  sessions = [
    {
      id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null, has_scored_matches: false,
      qualification_finalized_at: null, qualification_drops: null,
      live_scores_qualification: true, live_scores_finals: false,
    },
  ];
  stub();
});

describe("Match Control", () => {
  it("asks for an active session when there is none", async () => {
    event = { active_session_id: null };
    renderRoute();
    expect(await screen.findByText(/No session is active/)).toBeInTheDocument();
  });

  it("shows the field group's next match and starts it", async () => {
    renderRoute();
    const next = await screen.findByRole("region", { name: "Next match" });
    expect(within(next).getByText("Q1 · Field 1")).toBeInTheDocument();
    expect(within(next).getByText(/101A/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/start", { method: "POST" }));
  });

  it("switches field groups with the tabs and remembers the choice", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("tab", { name: "Side Fields" }));
    expect(await within(screen.getByRole("region", { name: "Next match" })).findByText("Q3 · Side 1")).toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.matchControl.fieldSet")).toBe("11");
  });

  it("queues a different next match and clears it", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Queue match"), { target: { value: "2" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/queued-match", { method: "PUT", body: { match_id: 2 } })
    );
    fieldSets[0] = { ...fieldSets[0], queued_match_id: 2 };
    stub();
    cleanup();
    renderRoute();
    const latest = await screen.findByRole("region", { name: "Next match" });
    expect(await within(latest).findByText("Q2 · Field 2")).toBeInTheDocument();
    fireEvent.click(within(latest).getByRole("button", { name: "Back to schedule order" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/queued-match", { method: "PUT", body: { match_id: null } })
    );
  });

  it("offers Pause and End early while running and blocks Start", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1) }), match({ id: 2, field_id: 2 })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).getByText("Driver control")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.click(within(timer).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/pause", { method: "POST" }));
    fireEvent.click(within(timer).getByRole("button", { name: "End early" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "End early" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/end", { method: "POST" }));
  });

  it("offers Resume instead of Pause while paused", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: null, paused: true, remaining_seconds_at_pause: 40 })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    fireEvent.click(within(timer).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/resume", { method: "POST" }));
  });

  it("shows the server's message when an action is refused", async () => {
    const base = vi.mocked(apiRequest).getMockImplementation()!;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/api/matches/1/start") throw new ApiError(409, "Another match is running on this field group.");
      return base(path, options as never);
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another match is running on this field group.");
  });

  it("starts driver control and resets the whole match", async () => {
    matches = [match({ id: 1, phase: "awaiting_driver" })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(within(timer).getByRole("button", { name: "Start driver control" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/start-driver", { method: "POST" }));
    fireEvent.click(within(timer).getByRole("button", { name: "Reset" }));
    const dialog = screen.getByRole("alertdialog", { name: "Reset the match?" });
    expect(within(dialog).queryByRole("button", { name: "Reset this period" })).not.toBeInTheDocument();
    // The whole-match reset also deletes every scorer's draft scores.
    expect(dialog).toHaveTextContent("Resetting the entire match timer also clears the draft scores.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset the whole match" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/reset", { method: "POST", body: { scope: "full" } })
    );
  });

  it("shows the last saved match with its scores", async () => {
    matches = [match({ id: 1, status: "completed", phase: "ended" }), match({ id: 2, field_id: 2 })];
    scores = [
      { match_id: 1, alliance_id: 11, score: 9, data: {}, teams: [], saved_at: soon(0) },
      { match_id: 1, alliance_id: 12, score: 3, data: {}, teams: [], saved_at: soon(0) },
    ];
    stub();
    renderRoute();
    const saved = await screen.findByRole("region", { name: "Saved match" });
    expect(within(saved).getByText("Q1")).toBeInTheDocument();
    expect(saved).toHaveTextContent("9");
    expect(saved).toHaveTextContent("3");
  });

  it("picks the audience screen, its settings and sounds", async () => {
    renderRoute();
    const panel = await screen.findByRole("region", { name: "Audience screen" });
    expect(within(panel).getByRole("button", { name: "Logo" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(panel).getByRole("button", { name: "Upcoming Matches" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", { method: "PATCH", body: { screen: "upcoming_matches" } })
    );
    audience = { ...audience, screen: "upcoming_matches", screen_settings: { count: 3, scope: "field_set" } };
    stub();
    cleanup();
    renderRoute();
    const latest = await screen.findByRole("region", { name: "Audience screen" });
    fireEvent.change(await within(latest).findByLabelText("Matches to show"), { target: { value: "5" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", {
        method: "PATCH",
        body: { screen_settings: { count: 5, scope: "field_set" } },
      })
    );
    fireEvent.click(within(latest).getByLabelText("Play sounds"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", { method: "PATCH", body: { play_sounds: true } })
    );
  });

  it("starts and cancels a time-out", async () => {
    renderRoute();
    const panel = await screen.findByRole("region", { name: "Time-out" });
    expect(within(panel).getByLabelText("Length in seconds")).toHaveValue(180);
    fireEvent.click(within(panel).getByRole("button", { name: "Start time-out" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/timeout", { method: "POST", body: { seconds: 180 } })
    );
    fieldSets[0] = { ...fieldSets[0], timeout_deadline: soon(2) };
    stub();
    cleanup();
    renderRoute();
    const latestPanel = await screen.findByRole("region", { name: "Time-out" });
    fireEvent.click(await within(latestPanel).findByRole("button", { name: "Cancel time-out" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/timeout", { method: "DELETE" }));
  });

  it("links the current match to its scoring page", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1) })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).getByRole("link", { name: "Score" })).toHaveAttribute("href", "/sessions/1/matches/1/score");
  });

  it("hides live scores for a qualification match and shows them for a finals match", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1) })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(await within(timer).findByRole("button", { name: "Hide live scores" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1", { method: "PATCH", body: { live_scores_qualification: false } })
    );
    cleanup();
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1), is_finals: true, round_type: "elimination" })];
    stub();
    renderRoute();
    const finalsTimer = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(await within(finalsTimer).findByRole("button", { name: "Show live scores" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1", { method: "PATCH", body: { live_scores_finals: true } })
    );
  });

  it("stops waiting for the score when the match is submitted", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    matches = [match({ id: 1, phase: "ended" })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).getByText("Match over — waiting for the score.")).toBeInTheDocument();
    matches = [match({ id: 1, phase: "ended", status: "completed" })];
    scores = [
      { match_id: 1, alliance_id: 11, score: 9, data: {}, teams: [], saved_at: soon(0) },
      { match_id: 1, alliance_id: 12, score: 3, data: {}, teams: [], saved_at: soon(0) },
    ];
    stub();
    act(() => onEvent?.({ event: "match_submitted", data: { match_id: 1 } }));
    expect(await within(timer).findByText("Score saved.")).toBeInTheDocument();
    expect(within(timer).queryByText("Match over — waiting for the score.")).not.toBeInTheDocument();
    expect(within(timer).queryByRole("link", { name: "Score" })).not.toBeInTheDocument();
  });

  it("lists teamwork field sets only", async () => {
    renderRoute();
    expect(await screen.findByRole("tab", { name: "Main Fields" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Side Fields" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Skills Row" })).not.toBeInTheDocument();
  });

  it("says there are no fields when the session has only skills sets", async () => {
    fieldSets = [fieldSets[2]];
    stub();
    renderRoute();
    expect(await screen.findByText("This session has no fields yet.")).toBeInTheDocument();
  });
});
