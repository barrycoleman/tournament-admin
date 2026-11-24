import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, screen } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELDS, FIELD_SETS, HEAD_TO_HEAD, audienceGroup, baseRoutes, fieldGroup, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

/** Lets the readings tick (every 0.1 s) for `ms`. */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const flash = () => screen.queryByTestId("cue-flash");

/** Ticks a tenth of a second at a time until a flash shows. */
async function untilFlash(limitMs = 5_000) {
  for (let waited = 0; waited < limitMs; waited += 100) {
    const found = flash();
    if (found) return found;
    await tick(100);
  }
  throw new Error("no flash");
}

/** Ticks through `ms`, failing as soon as any flash shows. */
async function expectNoFlashFor(ms: number) {
  for (let waited = 0; waited < ms; waited += 100) {
    expect(flash()).not.toBeInTheDocument();
    await tick(100);
  }
  expect(flash()).not.toBeInTheDocument();
}

function showMatch(group: Record<string, unknown>, matches: () => unknown[], extra: Record<string, unknown> = {}) {
  serveDisplay({ ...baseRoutes(), "/api/displays/me": me(group), "/api/matches?session_id=1": matches, ...extra });
  return renderDisplay();
}
const inMatchGroup = (overrides: Record<string, unknown> = {}) => audienceGroup({ screen: "in_match", ...overrides });

describe("cue flash on a match TV", () => {
  it("flashes amber with the moment's label, the border for about 1.5 s and the banner for about 2 s", async () => {
    showMatch(inMatchGroup(), () => [match({ id: 1, phase: "driver", phase_deadline: iso(35_600) })]);
    expect(await screen.findByTestId("clock")).toBeInTheDocument();
    const shown = await untilFlash();
    expect(shown).toHaveClass("cue-flash", "cue-flash--moment");
    expect(shown).toHaveAttribute("data-kind", "moment");
    expect(shown).toHaveClass("cue-flash--bottom");
    expect(shown.querySelector(".cue-flash__banner")).toHaveTextContent("Driver change");
    // The banner text shrinks to fit its box rather than running under the totals.
    expect(shown.querySelector(".cue-flash__banner .fit-line.cue-flash__text")).toHaveTextContent("Driver change");
    expect(shown.querySelector(".cue-flash__border")).toBeInTheDocument();
    await tick(1_300);
    expect(flash()?.querySelector(".cue-flash__border")).toBeInTheDocument();
    await tick(400);
    expect(flash()?.querySelector(".cue-flash__border")).not.toBeInTheDocument();
    expect(flash()?.querySelector(".cue-flash__banner")).toHaveTextContent("Driver change");
    await tick(500);
    expect(flash()).not.toBeInTheDocument();
    // The window tag carries on under the clock.
    expect(screen.getByTestId("window-tag")).toHaveTextContent("Driver change");
  });

  it("flashes white MATCH OVER when the match runs out", async () => {
    let matches = [match({ id: 1, phase: "driver", phase_deadline: iso(10_000) })];
    const { emit } = showMatch(inMatchGroup(), () => matches);
    expect(await screen.findByTestId("clock")).toBeInTheDocument();
    await tick(300);
    matches = [match({ id: 1, phase: "ended", phase_deadline: null })];
    emit("match_phase_changed", { match_id: 1 });
    const shown = await untilFlash();
    expect(shown).toHaveClass("cue-flash--over");
    expect(shown).toHaveAttribute("data-kind", "over");
    expect(shown).toHaveTextContent("MATCH OVER");
  });

  it("flashes red MATCH STOPPED when the operator ends the match early", async () => {
    let matches = [match({ id: 1, phase: "driver", phase_deadline: iso(50_000) })];
    const { emit } = showMatch(inMatchGroup(), () => matches);
    expect(await screen.findByTestId("clock")).toBeInTheDocument();
    await tick(300);
    matches = [match({ id: 1, phase: "ended", phase_deadline: null, ended_early: true })];
    emit("match_phase_changed", { match_id: 1 });
    const shown = await untilFlash();
    expect(shown).toHaveClass("cue-flash--stop");
    expect(shown).toHaveTextContent("MATCH STOPPED");
  });

  it("uses the Chinese banner texts", async () => {
    await i18n.changeLanguage("zh");
    let matches = [match({ id: 1, phase: "driver", phase_deadline: iso(50_000) })];
    const { emit } = showMatch(inMatchGroup(), () => matches);
    expect(await screen.findByTestId("clock")).toBeInTheDocument();
    await tick(300);
    matches = [match({ id: 1, phase: "ended", phase_deadline: null, ended_early: true })];
    emit("match_phase_changed", { match_id: 1 });
    expect(await untilFlash()).toHaveTextContent("比赛中止");
    await tick(2_500);
    matches = [match({ id: 2, phase: "driver", phase_deadline: iso(50_000) })];
    emit("match_phase_changed", { match_id: 2 });
    await tick(300);
    matches = [match({ id: 2, phase: "ended", phase_deadline: null })];
    emit("match_phase_changed", { match_id: 2 });
    expect(await untilFlash()).toHaveTextContent("比赛结束");
  });

  it("keeps the red banner on a field TV after a reset sends it back to the next match", async () => {
    let matches = [match({ id: 1, field_id: 1, phase: "driver", phase_deadline: iso(50_000) })];
    const { emit } = showMatch(fieldGroup(), () => matches);
    expect(await screen.findByTestId("clock")).toBeInTheDocument();
    await tick(300);
    matches = [match({ id: 1, field_id: 1, phase: "not_started", phase_deadline: null })];
    emit("match_reset", { match_id: 1 });
    const shown = await untilFlash();
    expect(shown).toHaveClass("cue-flash--stop");
    expect(screen.queryByTestId("clock")).not.toBeInTheDocument();
    expect(screen.getByTestId("start")).toBeInTheDocument();
    expect(flash()?.querySelector(".cue-flash__banner")).toHaveTextContent("MATCH STOPPED");
  });

  it("lets a new flash replace the one showing", async () => {
    let matches = [match({ id: 1, phase: "driver", phase_deadline: iso(35_600) })];
    const { emit } = showMatch(inMatchGroup(), () => matches);
    expect((await untilFlash())).toHaveAttribute("data-kind", "moment");
    matches = [match({ id: 1, phase: "ended", phase_deadline: null, ended_early: true })];
    emit("match_phase_changed", { match_id: 1 });
    await tick(300);
    expect(screen.getAllByTestId("cue-flash")).toHaveLength(1);
    expect(flash()).toHaveAttribute("data-kind", "stop");
    // The replacement keeps its full time.
    await tick(1_500);
    expect(flash()).toHaveAttribute("data-kind", "stop");
  });

  it("never flashes for a count-in, a start, the last three seconds or a time-out", async () => {
    let matches = [match({ id: 1, phase: "countdown_autonomous", phase_deadline: iso(2_500) })];
    const { emit } = showMatch(
      inMatchGroup({ field_set: { queued_match_id: null, timeout_deadline: iso(1_000) } }),
      () => matches,
      { "/api/event/match-format": { ...HEAD_TO_HEAD, moments: [] } }
    );
    // The time-out covers the count-in at first, then runs out.
    await expectNoFlashFor(2_000);
    expect(screen.getByTestId("count-in")).toBeInTheDocument();
    matches = [match({ id: 1, phase: "autonomous", phase_deadline: iso(6_000) })];
    emit("match_phase_changed", { match_id: 1 });
    await expectNoFlashFor(5_500);
  });

  it("raises the live totals above the banner only while a flash shows", async () => {
    const { container } = showMatch(inMatchGroup(), () => [match({ id: 1, phase: "driver", phase_deadline: iso(35_600) })]);
    expect(await screen.findByTestId("clock")).toBeInTheDocument();
    const display = container.querySelector(".display");
    expect(display).not.toHaveClass("display--flashing");
    await untilFlash();
    expect(display).toHaveClass("display--flashing");
    await tick(2_300);
    expect(flash()).not.toBeInTheDocument();
    expect(display).not.toHaveClass("display--flashing");
  });

  it("scopes every raise of the totals to a showing flash in the stylesheet", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/display.css"), "utf8");
    const rules = css.split("}").filter((rule) => /bottom-bar__(start|end)|in-match-score\s*\{/.test(rule) && /z-index/.test(rule));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const selector of rule.split("{")[0].split(",")) expect(selector.trim()).toMatch(/^\.display--flashing /);
    }
  });

  it("does not flash on an audience TV showing another screen", async () => {
    let matches = [match({ id: 1, phase: "driver", phase_deadline: iso(50_000) })];
    const { emit } = showMatch(audienceGroup({ screen: "logo" }), () => matches);
    await screen.findByRole("heading", { name: "Spring Invitational" });
    await tick(300);
    matches = [match({ id: 1, phase: "ended", phase_deadline: null, ended_early: true })];
    emit("match_phase_changed", { match_id: 1 });
    await expectNoFlashFor(1_000);
  });
});

const SKILLS_SET = { id: 20, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };
const SKILLS_FIELD = { id: 31, field_set_id: 20, name: "Skills 1" };
const SETTINGS = { enabled: true, attempts: {}, types: [{ key: "autonomous", label: "Autonomous", run_seconds: 60 }] };
function timer(overrides: Record<string, unknown> = {}) {
  return { field_set_id: 20, skills_type: "autonomous", phase: "ready", deadline: null, paused: false, remaining_seconds: null, run_seconds: 60, ended_early: false, ...overrides };
}
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, field_id: 31, field_set_id: 20, team_id: 1, team_number: "101A", team_name: "Rockets",
    skills_type: "autonomous", data: {}, item_meta: {}, version: 1, score: 0, follows_set: true,
    phase: "ready", deadline: null, paused: false, remaining_seconds: null, ended_early: false, ...overrides,
  };
}

function showSkills(group: Record<string, unknown>, set: () => unknown) {
  serveDisplay({
    ...baseRoutes(),
    "/api/displays/me": me(group),
    "/api/field-sets?session_id=1": [...FIELD_SETS, SKILLS_SET],
    "/api/fields?session_id=1": [...FIELDS, SKILLS_FIELD],
    "/api/skills/settings": SETTINGS,
    "/api/field-sets/20/skills": set,
    "/api/displays/live-scores?field_set_id=20": { matches: [], skills: [] },
    "/api/sessions/1/skills/attempts": [],
  });
  return renderDisplay();
}

describe("cue flash on a skills TV", () => {
  it("flashes white TIME on a skills field TV when the run runs out", async () => {
    const set = {
      timer: timer({ phase: "running", deadline: iso(1_500) }),
      fields: [{ field_id: 31, name: "Skills 1", run: run({ phase: "running", deadline: iso(1_500) }) }],
    };
    showSkills(fieldGroup({ id: 60, name: "Skills 1", field_set_id: 20, field_id: 31 }), () => set);
    expect(await screen.findByTestId("skills-clock")).toBeInTheDocument();
    const shown = await untilFlash();
    expect(shown).toHaveClass("cue-flash--over");
    expect(shown).toHaveTextContent("TIME");
    // On a skills TV the banner covers the title band, never the run's total at the bottom.
    expect(shown).toHaveClass("cue-flash--top");
    expect(shown).not.toHaveClass("cue-flash--bottom");
  });

  it("flashes red STOPPED on a skills audience TV when the set timer is stopped early", async () => {
    let set = { timer: timer({ phase: "running", deadline: iso(40_000) }), fields: [] as unknown[] };
    const { emit } = showSkills(audienceGroup({ name: "Skills Row", field_set_id: 20 }), () => set);
    expect(await screen.findByTestId("set-clock")).toBeInTheDocument();
    await tick(300);
    set = { timer: timer({ phase: "ended", deadline: null, ended_early: true }), fields: [] };
    emit("skills_run_changed", { field_set_id: 20 });
    const shown = await untilFlash();
    expect(shown).toHaveClass("cue-flash--stop");
    expect(shown).toHaveClass("cue-flash--top");
    expect(shown).toHaveTextContent("STOPPED");
    expect(shown).not.toHaveTextContent("MATCH");
  });

  it("uses the Chinese skills texts", async () => {
    await i18n.changeLanguage("zh");
    const set = {
      timer: timer({ phase: "running", deadline: iso(1_500) }),
      fields: [{ field_id: 31, name: "Skills 1", run: run({ phase: "running", deadline: iso(1_500) }) }],
    };
    showSkills(fieldGroup({ id: 60, name: "Skills 1", field_set_id: 20, field_id: 31 }), () => set);
    expect(await untilFlash()).toHaveTextContent("时间到");
  });
});
