import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n, type RealtimeEvent, type ScoresheetField } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionSkillsRoute } from "../../src/routes/SessionSkillsRoute";
import type { SessionRead, SessionSkillsType, SkillsAttemptRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, ApiError, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null,
  has_scored_matches: false, qualification_finalized_at: null, qualification_drops: null,
};
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: null },
  { id: 2, number: "202", name: "Bravo", division_id: null },
  { id: 3, number: "303", name: "Charlie", division_id: null },
];
const PARTICIPANTS = [
  { id: 1, session_id: 1, team_id: 1, checked_in: true },
  { id: 2, session_id: 1, team_id: 2, checked_in: true },
  { id: 3, session_id: 1, team_id: 3, checked_in: false },
];
const SCORE: ScoresheetField = {
  name: "score", label: "Score", data_type: "integer", widget: "counter",
  min: 0, max: 999, step: 1, options: null, icon: null, scope: "team", default: 0,
};
const BOTH: SessionSkillsType[] = [
  { key: "autonomous", label: "Autonomous", allowed: 3 },
  { key: "driver", label: "Driver", allowed: 1 },
];

function attempt(id: number, team_id: number, skills_type: string, number: number, score: number): SkillsAttemptRead {
  return { id, team_id, skills_type, number, score, data: { score }, recorded_at: "", updated_at: "" };
}

interface StubOptions {
  enabled?: boolean;
  types?: SessionSkillsType[];
  override?: Record<string, number> | null;
  attempts?: SkillsAttemptRead[];
  onPost?: (body: { team_id: number; skills_type: string; data: { score: number } }) => unknown;
  onPut?: (body: unknown) => unknown;
}

function stub({
  enabled = true,
  types = BOTH,
  override = null,
  attempts = [attempt(1, 1, "autonomous", 1, 20), attempt(2, 1, "driver", 1, 34)],
  onPost = (body) => ({ ...attempt(9, body.team_id, body.skills_type, 2, body.data.score), data: body.data }),
  onPut = () => ({ types, override: null }),
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path === "/api/skills/settings") {
      return { enabled, attempts: {}, types: types.map(({ key, label }) => ({ key, label })) } as never;
    }
    if (path === "/api/sessions/1/skills" && opts?.method === "PUT") return onPut(opts.body) as never;
    if (path === "/api/sessions/1/skills") return { types, override } as never;
    if (path === "/api/sessions/1/skills/attempts" && opts?.method === "POST") {
      const result = await onPost(opts.body as never);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/sessions/1/skills/attempts") return attempts as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/sessions/1/participants") return PARTICIPANTS as never;
    if (path.startsWith("/api/skills/types/")) return [SCORE] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderSkills() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionSkillsRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const calls = (method: string, path: string) =>
  vi.mocked(apiRequest).mock.calls.filter(
    ([p, options]) => p === path && ((options as { method?: string })?.method ?? "GET") === method
  );

async function recordRegion() {
  return screen.findByRole("region", { name: "Record an attempt" });
}

async function pickTeam(region: HTMLElement, label: string) {
  fireEvent.click(await within(region).findByRole("option", { name: label }));
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionSkillsRoute", () => {
  it("says skills are off, with a link to Event Setup", async () => {
    stub({ enabled: false });
    renderSkills();
    expect(await screen.findByText("Skills challenges are turned off for this event.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Event Setup" })).toHaveAttribute("href", "/events/setup");
  });

  it("shows the attempts line from the event setting", async () => {
    stub();
    renderSkills();
    expect(await screen.findByText("Autonomous 3 · Driver 1 (event setting)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use event setting" })).not.toBeInTheDocument();
  });

  it("changes and clears the session override", async () => {
    stub({ override: { driver: 1 } });
    renderSkills();
    expect(await screen.findByText("Autonomous 3 · Driver 1 (this session)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use event setting" }));
    await waitFor(() => expect(calls("PUT", "/api/sessions/1/skills")).toHaveLength(1));
    expect(calls("PUT", "/api/sessions/1/skills")[0][1]).toEqual({ method: "PUT", body: { attempts: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Change for this session" }));
    const autonomous = screen.getByLabelText("Autonomous attempts");
    expect(autonomous).toHaveValue("3");
    fireEvent.change(autonomous, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save for this session" }));
    expect(await screen.findByText("Enter a whole number from 1 to 20.")).toBeInTheDocument();
    expect(calls("PUT", "/api/sessions/1/skills")).toHaveLength(1);

    fireEvent.change(autonomous, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save for this session" }));
    await waitFor(() => expect(calls("PUT", "/api/sessions/1/skills")).toHaveLength(2));
    expect(calls("PUT", "/api/sessions/1/skills")[1][1]).toEqual({
      method: "PUT",
      body: { attempts: { autonomous: 2, driver: 1 } },
    });
  });

  it("offers only checked-in teams, matched by number or name", async () => {
    stub();
    renderSkills();
    const region = await recordRegion();
    expect(await within(region).findByRole("option", { name: "101 Alpha" })).toBeInTheDocument();
    expect(within(region).getByRole("option", { name: "202 Bravo" })).toBeInTheDocument();
    expect(within(region).queryByRole("option", { name: "303 Charlie" })).not.toBeInTheDocument();

    const search = within(region).getByRole("combobox", { name: "Team" });
    fireEvent.change(search, { target: { value: "brav" } });
    expect(within(region).getAllByRole("option").map((option) => option.textContent)).toEqual(["202 Bravo"]);
    fireEvent.change(search, { target: { value: "303" } });
    expect(within(region).getByText("No checked-in team matches.")).toBeInTheDocument();
  });

  it("records an attempt, says what it scored and resets the sheet", async () => {
    stub();
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "101 Alpha");
    expect(within(region).getByText("Attempt 2 of 3")).toBeInTheDocument();

    const score = await within(region).findByLabelText("Score");
    fireEvent.change(score, { target: { value: "25" } });
    fireEvent.click(within(region).getByRole("button", { name: "Save attempt" }));

    expect(await within(region).findByText("Saved: 25 points")).toBeInTheDocument();
    expect(calls("POST", "/api/sessions/1/skills/attempts")[0][1]).toEqual({
      method: "POST",
      body: { team_id: 1, skills_type: "autonomous", data: { score: 25 } },
    });
    expect(within(region).getByLabelText("Score")).toHaveValue("0");
  });

  it("disables Save with the reason once a type's attempts are used up", async () => {
    stub();
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "101 Alpha");
    fireEvent.click(within(region).getByRole("button", { name: "Driver" }));
    expect(within(region).getByText("Team 101 has used all 1 Driver attempts.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Save attempt" })).toBeDisabled();
  });

  it("shows field violations beside the field and other errors above Save", async () => {
    let reply: unknown = new ApiError(422, "The scoresheet has errors.", {
      detail: "The scoresheet has errors.",
      violations: [{ field: "score", message: "Must be at most 999." }],
    });
    stub({ onPost: () => reply });
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "202 Bravo");
    fireEvent.change(await within(region).findByLabelText("Score"), { target: { value: "1000" } });
    fireEvent.click(within(region).getByRole("button", { name: "Save attempt" }));

    expect(await within(region).findByText("Must be at most 999.")).toBeInTheDocument();
    expect(within(region).getByLabelText("Score")).toHaveAttribute("aria-invalid", "true");
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();

    reply = new ApiError(409, "Team 202 has used all 3 Autonomous attempts.");
    fireEvent.click(within(region).getByRole("button", { name: "Save attempt" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Team 202 has used all 3 Autonomous attempts.");
  });

  it("hides the type buttons when the game has one type", async () => {
    stub({ types: [{ key: "driver", label: "Driver", allowed: 3 }], attempts: [] });
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "202 Bravo");
    expect(within(region).queryByRole("group", { name: "Skills type" })).not.toBeInTheDocument();
    expect(within(region).getByText("Attempt 1 of 3")).toBeInTheDocument();
  });

  it("posts once when Save is clicked twice quickly", async () => {
    stub({ onPost: () => new Promise(() => {}) });
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "202 Bravo");
    await within(region).findByLabelText("Score");
    const save = within(region).getByRole("button", { name: "Save attempt" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(calls("POST", "/api/sessions/1/skills/attempts")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls("POST", "/api/sessions/1/skills/attempts")).toHaveLength(1);
  });

  it("refetches this session's attempts on skills_changed from the active-session channel", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      if (options.path === "/ws/active-session") onEvent = options.onEvent;
      return { connected: true };
    });
    stub();
    renderSkills();
    await recordRegion();
    const fetches = () => calls("GET", "/api/sessions/1/skills/attempts").length;
    const before = fetches();

    act(() => onEvent?.({ event: "skills_changed", data: { session_id: 2 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetches()).toBe(before);

    act(() => onEvent?.({ event: "skills_changed", data: { session_id: 1 } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
  });
});
