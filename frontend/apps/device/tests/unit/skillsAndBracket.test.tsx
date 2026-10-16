import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalsBracket } from "../../src/display/api";
import { seriesWins } from "../../src/display/logic/bracket";
import { baseRoutes, match, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (ms: number) => new Date(NOW + ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SKILLS = {
  enabled: true,
  attempts: { autonomous: 3, driver: 3 },
  types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
};

describe("Skills Rankings", () => {
  it("lists totals and each type's best and attempts used, with top 10 and recent scores", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "skills_rankings" })),
      "/api/skills/settings": SKILLS,
      "/api/skills/rankings?tab=overall&session_id=1": [
        { rank: 1, team_id: 2, score: 197, attempts: [90, 107] },
        { rank: 2, team_id: 1, score: 50, attempts: [50, 0] },
      ],
      "/api/skills/rankings?tab=autonomous&session_id=1": [
        { rank: 1, team_id: 2, score: 90, attempts: [90, 40] },
        { rank: 2, team_id: 1, score: 50, attempts: [50] },
      ],
      "/api/skills/rankings?tab=driver&session_id=1": [{ rank: 1, team_id: 2, score: 107, attempts: [107] }],
      "/api/sessions/1/skills/attempts": [
        { id: 1, team_id: 2, skills_type: "autonomous", score: 40, recorded_at: iso(-300_000) },
        { id: 2, team_id: 2, skills_type: "autonomous", score: 90, recorded_at: iso(-200_000) },
        { id: 3, team_id: 2, skills_type: "driver", score: 107, recorded_at: iso(-100_000) },
        { id: 4, team_id: 1, skills_type: "autonomous", score: 50, recorded_at: iso(-50_000) },
      ],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Skills Rankings" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent(/Rank.*Team.*Total.*Autonomous.*Driver/);
    expect(rows[1]).toHaveTextContent(/1.*102B.*Gears.*197.*90 \/ 2.*107 \/ 1/);
    expect(rows[2]).toHaveTextContent(/2.*101A.*50.*50 \/ 1.*0 \/ 0/);
    const top = screen.getByRole("complementary", { name: "Top 10" });
    expect(within(top).getAllByRole("row")[0]).toHaveTextContent(/1.*102B.*197.*90 \/ 107/);
    const recent = within(screen.getByRole("complementary", { name: "Recent scores" })).getAllByRole("row");
    expect(recent[0]).toHaveTextContent(/101A.*Autonomous.*50/);
    expect(recent[1]).toHaveTextContent(/102B.*Driver.*107/);
  });

  it("says so when skills challenges are off", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "skills_rankings" })),
      "/api/skills/settings": { ...SKILLS, enabled: false },
    });
    renderDisplay();
    expect(await screen.findByText("Skills challenges aren't running")).toBeInTheDocument();
  });
});

const ALLIANCES = [
  { id: 1, seed: 1, team_ids: [1], unavailable: false },
  { id: 2, seed: 2, team_ids: [2], unavailable: false },
  { id: 3, seed: 3, team_ids: [3], unavailable: false },
  { id: 4, seed: 4, team_ids: [4], unavailable: false },
];

function bracket(overrides: Partial<FinalsBracket>): FinalsBracket {
  return {
    id: 1, session_id: 1, division_id: null, field_set_id: 10, format: "single_elimination", bracket_size: 4,
    status: "in_progress", alliances: ALLIANCES, runs: [], results: [], matchups: [], ...overrides,
  };
}

describe("seriesWins", () => {
  it("counts each bracket alliance's game wins by matching its teams to a game's alliances", () => {
    const finals = bracket({
      matchups: [{ id: 7, round_number: 1, position: 0, matchup_number: 1, alliance_a_id: 1, alliance_b_id: 4, winner_alliance_id: null }],
    });
    const games = [
      match({ id: 1, is_finals: true, bracket_matchup_id: 7, status: "completed", alliances: [{ id: 11, station: "red", team_ids: [4] }, { id: 12, station: "blue", team_ids: [1] }] }),
      match({ id: 2, is_finals: true, bracket_matchup_id: 7, status: "completed", alliances: [{ id: 21, station: "red", team_ids: [1] }, { id: 22, station: "blue", team_ids: [4] }] }),
      match({ id: 3, is_finals: true, bracket_matchup_id: 7, alliances: [{ id: 31, station: "red", team_ids: [1] }, { id: 32, station: "blue", team_ids: [4] }] }),
    ];
    const scores = [
      { match_id: 1, alliance_id: 11, score: 9, data: {}, teams: [], saved_at: iso(0) },
      { match_id: 1, alliance_id: 12, score: 3, data: {}, teams: [], saved_at: iso(0) },
      { match_id: 2, alliance_id: 21, score: 8, data: {}, teams: [], saved_at: iso(0) },
      { match_id: 2, alliance_id: 22, score: 2, data: {}, teams: [], saved_at: iso(0) },
    ];
    expect(seriesWins(finals, games, scores).get(7)).toEqual({ a: 1, b: 1 });
  });
});

describe("Elimination Brackets", () => {
  it("draws a single-elimination tree with round names and winners", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })),
      "/api/finals?session_id=1&division_id=4": [],
      "/api/finals?session_id=1": [
        bracket({
          matchups: [
            { id: 1, round_number: 1, position: 0, matchup_number: 1, alliance_a_id: 1, alliance_b_id: 4, winner_alliance_id: 1 },
            { id: 2, round_number: 1, position: 1, matchup_number: 2, alliance_a_id: 2, alliance_b_id: 3, winner_alliance_id: null },
            { id: 3, round_number: 2, position: 0, matchup_number: 3, alliance_a_id: 1, alliance_b_id: null, winner_alliance_id: null },
          ],
        }),
      ],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Semifinals" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
    const first = screen.getByTestId("matchup-1");
    expect(within(first).getByTestId("side-1")).toHaveClass("is-winner");
    expect(within(first).getByTestId("side-1")).toHaveTextContent("101A");
  });

  it("shows score-chase finals rankings with the runs panel", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })),
      "/api/matches?session_id=1": [
        match({ id: 61, label: "F1", is_finals: true, status: "completed", phase: "ended", field_id: 1 }),
        match({ id: 62, label: "F2", is_finals: true, field_id: 1 }),
      ],
      "/api/finals?session_id=1&division_id=4": [],
      "/api/finals?session_id=1": [
        bracket({
          format: "score_chase",
          alliances: [{ id: 1, seed: 1, team_ids: [1, 2], unavailable: false }, { id: 2, seed: 2, team_ids: [3, 4], unavailable: false }],
          runs: [
            { match_id: 61, bracket_alliance_id: 2, status: "completed", score: 84 },
            { match_id: 62, bracket_alliance_id: 1, status: "scheduled", score: null },
          ],
          results: [{ bracket_alliance_id: 2, score: 84, rank: 1 }],
        }),
      ],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Finals rankings" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/1.*103C.*104D.*1.*84/);
    const runs = screen.getByRole("complementary", { name: "Match schedule & results" });
    expect(within(runs).getByText("F2").closest("tr")).toHaveClass("is-current");
  });

  it("says when there are no eliminations yet", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })), "/api/finals?session_id=1": [], "/api/finals?session_id=1&division_id=4": [] });
    renderDisplay();
    expect(await screen.findByText("No eliminations yet")).toBeInTheDocument();
  });

  it("finds a bracket that carries the event's only division", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })),
      "/api/finals?session_id=1": [],
      "/api/finals?session_id=1&division_id=4": [
        bracket({
          division_id: 4,
          matchups: [{ id: 1, round_number: 1, position: 0, matchup_number: 1, alliance_a_id: 1, alliance_b_id: 4, winner_alliance_id: null }],
        }),
      ],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Final" })).toBeInTheDocument();
    expect(screen.getByTestId("matchup-1")).toBeInTheDocument();
  });

  it("in a multi-division event, a division's group ignores a newer no-division bracket", async () => {
    const matchup = (id: number) => [{ id, round_number: 1, position: 0, matchup_number: 1, alliance_a_id: 1, alliance_b_id: 4, winner_alliance_id: null }];
    serveDisplay({
      ...baseRoutes(),
      "/api/divisions": [{ id: 4, name: "Division 1" }, { id: 5, name: "Division 2" }],
      "/api/displays/me": me(pitGroup({ screen: "elimination_bracket", division_id: 5 })),
      "/api/finals?session_id=1&division_id=5": [bracket({ id: 1, division_id: 5, matchups: matchup(51) })],
      "/api/finals?session_id=1": [bracket({ id: 2, division_id: null, matchups: matchup(52) })],
    });
    renderDisplay();
    expect(await screen.findByTestId("matchup-51")).toBeInTheDocument();
    expect(screen.queryByTestId("matchup-52")).not.toBeInTheDocument();
  });
});
