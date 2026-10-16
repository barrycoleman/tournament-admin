import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamRecords } from "../../src/display/logic/records";
import { COOPERATIVE, audienceGroup, baseRoutes, match, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const ranking = (team_id: number, rank: number, extra = {}) => ({
  team_id, rank, division_id: null, win_points: 6 - rank, strength_of_schedule: 1.5, average_score: 40 - rank, matches_played: 2, ...extra,
});
const scoreRow = (match_id: number, alliance_id: number, score: number, saved = iso(-1_000)) => ({
  match_id, alliance_id, score, data: {}, teams: [], saved_at: saved,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("teamRecords", () => {
  it("counts wins, losses and ties from fully scored qualification matches", () => {
    const won = match({ id: 1, status: "completed" });
    const tied = match({ id: 2, status: "completed" });
    const practice = match({ id: 3, status: "completed", round_type: "practice" });
    const scores = [scoreRow(1, 11, 9), scoreRow(1, 12, 3), scoreRow(2, 21, 4), scoreRow(2, 22, 4), scoreRow(3, 31, 9), scoreRow(3, 32, 0)];
    const records = teamRecords([won, tied, practice], scores);
    expect(records.get(1)).toEqual({ wins: 1, losses: 0, ties: 1 });
    expect(records.get(3)).toEqual({ wins: 0, losses: 1, ties: 1 });
  });
});

describe("Teamwork Rankings", () => {
  it("lists the head-to-head columns and the schedule and results panel", async () => {
    const done = match({ id: 1, label: "Q1", status: "completed", phase: "ended", scheduled_time: iso(-600_000) });
    const next = match({ id: 2, label: "Q2", field_id: 2, scheduled_time: iso(300_000) });
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": [ranking(3, 1), ranking(1, 2)],
      "/api/matches?session_id=1": [done, next],
      "/api/scores?session_id=1": [scoreRow(1, 11, 3), scoreRow(1, 12, 9)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent(/Rank.*Team.*WP.*SoS.*W-L-T/);
    expect(rows[1]).toHaveTextContent(/1.*103C.*Bolts.*5.*1\.5.*1-0-0/);
    expect(rows[2]).toHaveTextContent(/2.*101A.*Rockets.*4.*0-1-0/);
    const panel = await screen.findByRole("complementary", { name: "Match schedule & results" });
    expect(within(panel).getByText("Q1").closest("tr")).toHaveTextContent("3–9");
    expect(within(panel).getByText("Q2").closest("tr")).toHaveTextContent(/Field 2.*4:05/);
  });

  it("shows matches and average score columns for a cooperative game", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": [ranking(2, 1)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    expect(within(table).getAllByRole("row")[0]).toHaveTextContent(/Rank.*Team.*Matches.*Average/);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/1.*102B.*2.*39/);
  });

  it("in a multi-division event, a division's group leaves out the no-division rankings", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/divisions": [{ id: 4, name: "Division 1" }, { id: 5, name: "Division 2" }],
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings", division_id: 5 })),
      "/api/rankings?session_id=1&division_id=5": [ranking(3, 1, { division_id: 5 })],
      "/api/rankings?session_id=1": [ranking(2, 1)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("103C")).toBeInTheDocument();
    expect(within(table).queryByText("102B")).not.toBeInTheDocument();
  });

  it("says when nothing is ranked yet", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })) });
    renderDisplay();
    expect(await screen.findByText("No rankings yet")).toBeInTheDocument();
  });
});

describe("match lists", () => {
  const matches = [
    match({ id: 1, label: "Q1", status: "completed", phase: "ended", scheduled_time: iso(-600_000) }),
    match({ id: 2, label: "Q2", status: "completed", phase: "ended", scheduled_time: iso(-300_000) }),
    match({ id: 3, label: "Q3", scheduled_time: iso(300_000) }),
    match({ id: 4, label: "Q4", field_id: 2, scheduled_time: iso(600_000) }),
    match({ id: 5, label: "Q5", field_id: 9, scheduled_time: iso(900_000) }),
  ];
  const scores = [scoreRow(1, 11, 5, iso(-500_000)), scoreRow(1, 12, 2, iso(-500_000)), scoreRow(2, 21, 1, iso(-100_000)), scoreRow(2, 22, 8, iso(-100_000))];

  it("Upcoming Matches shows the next few on the audience's field group", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "upcoming_matches", screen_settings: { count: 3, scope: "field_set" } })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Upcoming Matches" });
    // Q5 is on field 9, outside the audience's field set, so it is left out.
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent?.slice(0, 2))).toEqual(["Q3", "Q4"]);
  });

  it("Upcoming Matches by division includes other field groups' matches", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "upcoming_matches", screen_settings: { count: 3, scope: "division" } })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Upcoming Matches" });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent?.slice(0, 2))).toEqual(["Q3", "Q4", "Q5"]);
  });

  it("Match Results lists scored matches newest first with both scores", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "match_results" })),
      "/api/matches?session_id=1": matches,
      "/api/scores?session_id=1": scores,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Results" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent(/Q2.*1.*8/);
    expect(rows[1]).toHaveTextContent(/Q1.*5.*2/);
  });

  it("the Schedule shows times in the session's zone", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/sessions": [{ id: 1, label: "Saturday", timezone: "Asia/Tokyo" }],
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Schedule" })).getAllByRole("row").slice(1);
    expect(rows[3]).toHaveTextContent(/1:10/);
  });

  it("the Schedule shows times in UTC, labeled, when the session has no zone", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/sessions": [{ id: 1, label: "Saturday", timezone: null }],
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Schedule" })).getAllByRole("row").slice(1);
    expect(rows[3]).toHaveTextContent(/4:10.*UTC/);
  });

  it("Upcoming Matches shows times in UTC, labeled, when the session has no zone", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/sessions": [{ id: 1, label: "Saturday", timezone: null }],
      "/api/displays/me": me(audienceGroup({ screen: "upcoming_matches", screen_settings: { count: 3, scope: "field_set" } })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Upcoming Matches" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/4:05.*UTC/);
  });

  it("the Schedule keeps waiting while the sessions have not loaded", async () => {
    const routes = { ...baseRoutes(), "/api/displays/me": me(pitGroup({ screen: "schedule" })), "/api/matches?session_id=1": matches } as Record<string, unknown>;
    delete routes["/api/sessions"];
    serveDisplay(routes);
    renderDisplay();
    expect(await screen.findByText("Waiting for data")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Match Schedule" })).not.toBeInTheDocument();
  });

  it("Schedule lists every match in order with field and time", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Schedule" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.slice(0, 2))).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    expect(rows[0]).toHaveClass("is-done");
    expect(rows[3]).toHaveTextContent(/Field 2.*4:10/);
  });
});
