import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELDS, FIELD_SETS, audienceGroup, baseRoutes, fieldGroup, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const SKILLS_SET = { id: 20, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };
const SKILLS_FIELD = { id: 31, field_set_id: 20, name: "Skills 1" };
const SETTINGS = {
  enabled: true,
  attempts: {},
  types: [
    { key: "autonomous", label: "Autonomous", run_seconds: 60 },
    { key: "driver", label: "Driver", run_seconds: 60 },
  ],
};

function timer(overrides: Record<string, unknown> = {}) {
  return { field_set_id: 20, skills_type: "autonomous", phase: "ready", deadline: null, paused: false, remaining_seconds: null, run_seconds: 60, ...overrides };
}
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, field_id: 31, field_set_id: 20, team_id: 1, team_number: "101A", team_name: "Rockets",
    skills_type: "autonomous", data: {}, item_meta: {}, version: 1, score: 0, follows_set: true,
    phase: "ready", deadline: null, paused: false, remaining_seconds: null, ...overrides,
  };
}
const fieldRow = (fieldRun: unknown) => ({ field_id: 31, name: "Skills 1", run: fieldRun });

let set: { timer: unknown; fields: unknown[] };
let live: { matches: unknown[]; skills: unknown[] };
let attempts: unknown[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  set = { timer: timer(), fields: [fieldRow(null)] };
  live = { matches: [], skills: [] };
  attempts = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(group: Record<string, unknown>) {
  serveDisplay({
    ...baseRoutes(),
    "/api/displays/me": me(group),
    "/api/field-sets?session_id=1": [...FIELD_SETS, SKILLS_SET],
    "/api/fields?session_id=1": [...FIELDS, SKILLS_FIELD],
    "/api/skills/settings": SETTINGS,
    "/api/field-sets/20/skills": () => set,
    "/api/displays/live-scores?field_set_id=20": () => live,
    "/api/sessions/1/skills/attempts": () => attempts,
  });
  return renderDisplay();
}
const showFieldTv = () => show(fieldGroup({ id: 60, name: "Skills 1", field_set_id: 20, field_id: 31 }));

describe("skills field TV", () => {
  it("waits for the next team while the field has no run", async () => {
    showFieldTv();
    expect(await screen.findByText("Skills · Waiting for the next team")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Skills 1" })).toBeInTheDocument();
  });

  it("shows the team, the type and the full run time once a run is created", async () => {
    set = { timer: timer(), fields: [fieldRow(run())] };
    showFieldTv();
    expect(await screen.findByText("101A")).toBeInTheDocument();
    expect(screen.getByText("Rockets")).toBeInTheDocument();
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
    expect(screen.getByTestId("skills-clock")).toHaveTextContent("1:00");
  });

  it("counts down while running and shows the live total only while the server sends one", async () => {
    set = { timer: timer({ phase: "running", deadline: iso(45_000) }), fields: [fieldRow(run({ phase: "running", deadline: iso(45_000) }))] };
    const { emit } = showFieldTv();
    expect(await screen.findByTestId("skills-clock")).toHaveTextContent("0:45");
    expect(screen.queryByTestId("skills-live")).not.toBeInTheDocument();
    live = { matches: [], skills: [{ field_id: 31, score: 17 }] };
    emit("live_score", { field_id: 31, score: 17 });
    expect(await screen.findByTestId("skills-live")).toHaveTextContent("17");
    expect(screen.getByTestId("skills-live")).toHaveTextContent("Live");
    live = { matches: [], skills: [] };
    emit("live_score", { field_id: 31, cleared: true });
    await waitFor(() => expect(screen.queryByTestId("skills-live")).not.toBeInTheDocument());
  });

  it("shows Run over and fills in the breakdown after the timer", async () => {
    set = { timer: timer({ phase: "ended" }), fields: [fieldRow(run({ phase: "ended" }))] };
    live = { matches: [], skills: [{ field_id: 31, score: 17, breakdown: [{ label: "Score", value: 17 }] }] };
    const { emit } = showFieldTv();
    expect(await screen.findByText("Run over")).toBeInTheDocument();
    const breakdown = screen.getByRole("list", { name: "Score breakdown" });
    expect(within(breakdown).getByText("Score")).toBeInTheDocument();
    expect(within(breakdown).getByText("17")).toBeInTheDocument();
    expect(screen.getByTestId("skills-total")).toHaveTextContent("17");
    live = { matches: [], skills: [{ field_id: 31, score: 21, breakdown: [{ label: "Score", value: 21 }] }] };
    emit("live_score", live.skills[0]);
    expect(await within(breakdown).findByText("21")).toBeInTheDocument();
    expect(screen.getByTestId("skills-total")).toHaveTextContent("21");
  });

  it("shows the final score after Submit, and waiting again after a Discard", async () => {
    set = { timer: timer(), fields: [fieldRow(run())] };
    const { emit } = showFieldTv();
    expect(await screen.findByText("101A")).toBeInTheDocument();

    set = { timer: timer(), fields: [fieldRow(null)] };
    attempts = [{ id: 9, team_id: 1, skills_type: "autonomous", score: 23, recorded_at: iso(0), field_id: 31 }];
    emit("skills_run_changed", { field_set_id: 20, field_id: 31 });
    emit("skills_changed", { session_id: 1 });
    expect(await screen.findByTestId("skills-final")).toHaveTextContent("23");
    expect(screen.getByText("Final score")).toBeInTheDocument();

    set = { timer: timer(), fields: [fieldRow(run({ id: 2, team_id: 2, team_number: "102B", team_name: "Gears" }))] };
    emit("skills_run_changed", { field_set_id: 20, field_id: 31 });
    expect(await screen.findByText("102B")).toBeInTheDocument();

    set = { timer: timer(), fields: [fieldRow(null)] };
    emit("skills_run_changed", { field_set_id: 20, field_id: 31 });
    expect(await screen.findByText("Skills · Waiting for the next team")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-final")).not.toBeInTheDocument();
  });
});

describe("skills set TV", () => {
  it("shows the set's name, type and countdown, and never a score", async () => {
    set = { timer: timer({ phase: "running", deadline: iso(30_000) }), fields: [fieldRow(run({ phase: "running", deadline: iso(30_000) }))] };
    live = { matches: [], skills: [{ field_id: 31, score: 17 }] };
    show(audienceGroup({ id: 61, name: "Skills Row", field_set_id: 20, screen: "in_match" }));
    await screen.findByTestId("set-clock");
    expect(await screen.findByRole("heading", { name: "Skills Row" })).toBeInTheDocument();
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
    expect(screen.getByTestId("set-clock")).toHaveTextContent("0:30");
    expect(screen.queryByText("17")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(screen.getByTestId("set-clock")).toHaveTextContent("0:00");
    expect(screen.getByText("Time's up")).toBeInTheDocument();
  });
});
