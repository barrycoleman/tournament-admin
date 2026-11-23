import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamRecords } from "../../src/display/logic/records";
import { screenModule } from "../../src/display/screens/registry";
import { COOPERATIVE, DIVISIONS, audienceGroup, baseRoutes, match, me, pitGroup } from "./displayFixtures";
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
  it("lists the head-to-head columns, with no side panel", async () => {
    const done = match({ id: 1, label: "Q1", status: "completed", phase: "ended", scheduled_time: iso(-600_000) });
    const next = match({ id: 2, label: "Q2", field_id: 2, scheduled_time: iso(300_000) });
    const ranks = [ranking(3, 1), ranking(1, 2), ranking(2, 3), ranking(4, 4)];
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": ranks,
      "/api/matches?session_id=1": [done, next],
      "/api/scores?session_id=1": [scoreRow(1, 11, 3), scoreRow(1, 12, 9)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent(/Rank.*Team.*Name.*W-L-T.*WP.*SoS/);
    expect(rows[1]).toHaveTextContent(/1.*103C.*Bolts.*1-0-0.*5.*1\.5/);
    expect(rows[2]).toHaveTextContent(/2.*101A.*Rockets.*0-1-0.*4/);
    expect(screen.getByTestId("rank-row-3")).toBeInTheDocument();
    const rankCell = (n: number) => within(rows[n]).getAllByRole("cell")[0];
    [1, 2, 3].forEach((n) => expect(rankCell(n)).toHaveClass("is-top"));
    expect(rankCell(4)).not.toHaveClass("is-top");
    expect(screen.queryByText("Match schedule & results")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByText("After 1 of 2 qualification matches")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Teamwork rankings" })).toBeInTheDocument();
    expect(table.closest(".table-screen")).toHaveClass("table-screen--pit");
  });

  it("leaves a not-played qualification match out of the progress count", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": [ranking(3, 1)],
      "/api/matches?session_id=1": [
        match({ id: 1, label: "Q1", status: "completed", phase: "ended" }),
        match({ id: 2, label: "Q2", status: "not_played" }),
        match({ id: 3, label: "Q3" }),
      ],
      "/api/scores?session_id=1": [scoreRow(1, 11, 3), scoreRow(1, 12, 9)],
    });
    renderDisplay();
    expect(await screen.findByText("After 1 of 2 qualification matches")).toBeInTheDocument();
  });

  it("uses the audience size when shown at a field set", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": [ranking(3, 1)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    expect(table.closest(".table-screen")).toHaveClass("table-screen--audience");
    expect(table.closest(".table-screen")).not.toHaveClass("table-screen--pit");
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

  it("Match Results is a scoreboard: red teams, red score, blue score, blue teams, with the loser dimmed", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "match_results" })),
      "/api/matches?session_id=1": matches,
      "/api/scores?session_id=1": scores,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Results" })).getAllByRole("row").slice(1);
    // Q2: red 1, blue 8 -> red lost.
    const q2 = rows[0];
    expect(q2.querySelector(".score-red")).toHaveTextContent("1");
    expect(q2.querySelector(".score-blue")).toHaveTextContent("8");
    expect(q2.querySelector(".results-teams--red")).toHaveTextContent("101A102B");
    expect(q2.querySelector(".results-teams--blue")).toHaveTextContent("103C104D");
    expect(q2.querySelector(".results-teams--red")).toHaveClass("is-loser");
    expect(q2.querySelector(".score-red")).toHaveClass("is-loser");
    expect(q2.querySelector(".results-teams--blue")).not.toHaveClass("is-loser");
    expect(q2.querySelector(".score-blue")).not.toHaveClass("is-loser");
    // Q1: red 5, blue 2 -> blue lost.
    expect(rows[1].querySelector(".score-blue")).toHaveClass("is-loser");
    expect(rows[1].querySelector(".results-teams--blue")).toHaveClass("is-loser");
    expect(rows[1].querySelector(".score-red")).not.toHaveClass("is-loser");
  });

  it("Match Results dims neither side on a tie", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "match_results" })),
      "/api/matches?session_id=1": [matches[0]],
      "/api/scores?session_id=1": [scoreRow(1, 11, 4), scoreRow(1, 12, 4)],
    });
    renderDisplay();
    const row = within(await screen.findByRole("table", { name: "Match Results" })).getAllByRole("row")[1];
    expect(row.querySelector(".score-red")).toHaveTextContent("4");
    expect(row.querySelector(".score-blue")).toHaveTextContent("4");
    expect(row.querySelector(".is-loser")).toBeNull();
  });

  it("Match Results shows a cooperative match's teams in side colours and one combined score", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(pitGroup({ screen: "match_results" })),
      "/api/matches?session_id=1": [matches[0]],
      "/api/scores?session_id=1": [scoreRow(1, 11, 37), scoreRow(1, 12, 37)],
    });
    renderDisplay();
    const row = within(await screen.findByRole("table", { name: "Match Results" })).getAllByRole("row")[1];
    expect(row.querySelectorAll(".score-combined")).toHaveLength(1);
    expect(row.querySelector(".score-combined")).toHaveTextContent("37");
    expect(row.querySelector(".score-red")).toBeNull();
    expect(row.querySelector(".results-teams--red")).toHaveTextContent("101A102B");
    expect(row.querySelector(".results-teams--blue")).toHaveTextContent("103C104D");
    expect(row.querySelector(".is-loser")).toBeNull();
  });

  it("Match Results puts a solo run's better ranked team on red", async () => {
    const solo = match({ id: 1, label: "Q1", status: "completed", phase: "ended", alliances: [{ id: 11, station: "solo", team_ids: [1, 3] }] });
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "match_results" })),
      "/api/matches?session_id=1": [solo],
      "/api/scores?session_id=1": [scoreRow(1, 11, 20)],
      "/api/rankings?session_id=1": [ranking(1, 4), ranking(3, 1)],
    });
    renderDisplay();
    const row = within(await screen.findByRole("table", { name: "Match Results" })).getAllByRole("row")[1];
    await vi.waitFor(() => expect(row.querySelector(".results-teams--red")).toHaveTextContent("103C"));
    expect(row.querySelector(".results-teams--blue")).toHaveTextContent("101A");
  });

  it("Upcoming Matches has red and blue team columns", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "upcoming_matches", screen_settings: { count: 3, scope: "field_set" } })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Upcoming Matches" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Match", "Red", "Blue", "Field", "Time"]);
    const cells = within(within(table).getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("101A102B");
    expect(cells[0].querySelector(".team-numbers--red")).not.toBeNull();
    expect(cells[1]).toHaveTextContent("103C104D");
    expect(cells[1].querySelector(".team-numbers--blue")).not.toBeNull();
    expect(table.closest(".table-screen")).toHaveClass("table-screen--audience");
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

  it("Schedule lists the matches from just before now, with red and blue columns, field and time", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Match Schedule" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.slice(0, 2))).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Match", "Time", "Field", "Red", "Blue"]);
    expect(rows[0]).toHaveClass("is-done");
    expect(rows[2]).not.toHaveClass("is-done");
    // Red teams then blue teams, each in their own cell.
    const cells = within(rows[3]).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent(/4:10/);
    expect(cells[1]).toHaveTextContent("Field 2");
    expect(cells[2]).toHaveTextContent("101A102B");
    expect(cells[2].querySelector(".team-numbers--red")).not.toBeNull();
    expect(cells[3]).toHaveTextContent("103C104D");
    expect(cells[3].querySelector(".team-numbers--blue")).not.toBeNull();
    expect(screen.getByText("Qualification · 2 of 5 played")).toBeInTheDocument();
  });

  it("Schedule tags one match per field as on field", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Match Schedule" });
    const tags = within(table).getAllByTestId("on-field");
    expect(tags).toHaveLength(2);
    const rows = within(table).getAllByRole("row").slice(1);
    // Field 1's next match is Q3 and field 2's is Q4; Q5 is on a field that is not in the session.
    expect(rows[2]).toHaveClass("is-on-field");
    expect(rows[3]).toHaveClass("is-on-field");
    expect(rows[2]).toContainElement(tags[0]);
    expect(rows[4]).not.toHaveClass("is-on-field");
    expect(tags[0]).toHaveTextContent("On field");
  });

  it("Schedule does not tag a division's match as on field while another division's match runs on the shared field", async () => {
    const shared = [
      match({ id: 1, label: "Q1", division_id: 5, phase: "running", scheduled_time: iso(-60_000) }),
      match({ id: 2, label: "Q2", division_id: 4, scheduled_time: iso(300_000) }),
    ];
    serveDisplay({
      ...baseRoutes(),
      "/api/divisions": [...DIVISIONS, { id: 5, name: "Division 2" }],
      "/api/displays/me": me(pitGroup({ screen: "schedule", division_id: 4 })),
      "/api/rankings?session_id=1&division_id=4": [],
      "/api/matches?session_id=1": shared,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Match Schedule" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.slice(0, 2))).toEqual(["Q2"]);
    expect(rows[0]).not.toHaveClass("is-on-field");
    expect(within(table).queryByTestId("on-field")).not.toBeInTheDocument();
  });

  it("Schedule starts two played matches before the first unplayed one and shows a dash for a finals match with no time", async () => {
    const long = [
      ...[1, 2, 3, 4].map((id) => match({ id, label: `Q${id}`, status: "completed", phase: "ended", scheduled_time: iso(-1_000_000 + id) })),
      match({ id: 5, label: "Q5", scheduled_time: iso(300_000) }),
      match({ id: 6, label: "F1", round_type: "finals", is_finals: true, scheduled_time: null }),
    ];
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(pitGroup({ screen: "schedule" })), "/api/matches?session_id=1": long });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Schedule" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.slice(0, 2))).toEqual(["Q3", "Q4", "Q5", "F1"]);
    expect(within(rows[3]).getAllByRole("cell")[0]).toHaveTextContent("–");
  });

  it("Schedule puts a solo run's better ranked team on red", async () => {
    const solo = [match({ id: 1, label: "Q1", scheduled_time: iso(300_000), alliances: [{ id: 11, station: "solo", team_ids: [1, 3] }] })];
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": solo,
      "/api/rankings?session_id=1": [ranking(1, 4), ranking(3, 1)],
    });
    renderDisplay();
    const row = within(await screen.findByRole("table", { name: "Match Schedule" })).getAllByRole("row")[1];
    await vi.waitFor(() => expect(within(row).getAllByRole("cell")[2]).toHaveTextContent("103C"));
    expect(within(row).getAllByRole("cell")[3]).toHaveTextContent("101A");
  });
});

describe("Schedule by Team", () => {
  const team = (id: number, number: string, division_id = 4) => ({ id, number, name: `T${id}`, division_id, city: null, state: null, country: null });
  const teams = [team(1, "83897A"), team(2, "10A"), team(3, "9A"), team(4, "7Z"), team(5, "5X", 5)];
  const pair = (id: number, red: number[], blue: number[]) => [
    { id: id * 10 + 1, station: "red", team_ids: red },
    { id: id * 10 + 2, station: "blue", team_ids: blue },
  ];
  const matches = [
    match({ id: 1, label: "Q13", field_id: 1, scheduled_time: iso(300_000), alliances: pair(1, [2], [3]) }),
    match({ id: 2, label: "Q20", field_id: 2, scheduled_time: iso(600_000), alliances: pair(2, [3], [2]) }),
    match({ id: 3, label: "Q27", field_id: 1, scheduled_time: iso(900_000), alliances: pair(3, [2], [3]) }),
    match({ id: 4, label: "F1", field_id: 1, round_type: "finals", is_finals: true, scheduled_time: null, alliances: pair(4, [1], [3]) }),
    match({ id: 5, label: "Q1", status: "completed", phase: "ended", scheduled_time: iso(-300_000), alliances: pair(5, [4], [1]) }),
  ];
  const serve = (list = matches, group = pitGroup({ screen: "team_schedule", division_id: 4 })) =>
    serveDisplay({
      ...baseRoutes(),
      "/api/divisions": [...DIVISIONS, { id: 5, name: "Division 2" }],
      "/api/teams": teams,
      "/api/displays/me": me(group),
      "/api/matches?session_id=1": list,
    });

  it("lists the division's teams in number order", async () => {
    serve();
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Schedule by Team" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["team-row-4", "team-row-3", "team-row-2", "team-row-1"]);
    expect(rows.map((r) => within(r).getAllByRole("rowheader")[0].textContent)).toEqual(["7Z", "9A", "10A", "83897A"]);
    expect(screen.getByText("Next matches · teams in number order")).toBeInTheDocument();
    expect(screen.queryByTestId("team-row-5")).not.toBeInTheDocument();
  });

  it("shows three cells with label, field, time and a dot for the team's side", async () => {
    serve();
    renderDisplay();
    const first = await screen.findByTestId("next-2-0");
    expect(first).toHaveTextContent("Q13 · F1 · 4:05 PM");
    expect(first.querySelector(".side-dot--red")).not.toBeNull();
    expect(screen.getByTestId("next-2-1").querySelector(".side-dot--blue")).not.toBeNull();
    expect(screen.getByTestId("next-2-1")).toHaveTextContent("Q20 · F2 · 4:10 PM");
    expect(screen.getByTestId("next-2-2")).toHaveTextContent("Q27");
  });

  it("shows now for a running match, leaves off a missing time, and dashes empty cells", async () => {
    const running = matches.map((m) => (m.id === 1 ? { ...m, phase: "driver", status: "in_progress" } : m));
    serve(running as typeof matches);
    renderDisplay();
    expect(await screen.findByTestId("next-2-0")).toHaveTextContent("Q13 · F1 · now");
    expect(screen.getByTestId("next-1-0")).toHaveTextContent(/^F1 · F1$/);
    expect(screen.getByTestId("next-1-1")).toHaveTextContent("–");
    expect(screen.getByTestId("next-1-2")).toHaveTextContent("–");
  });

  it("shows a muted No more matches for a team with none left", async () => {
    serve();
    renderDisplay();
    await screen.findByTestId("team-row-4");
    const row = screen.getByTestId("team-row-4");
    expect(row).toHaveTextContent("No more matches");
    expect(screen.queryByTestId("next-4-0")).not.toBeInTheDocument();
    expect(within(row).getByText("No more matches")).toHaveAttribute("colspan", "3");
  });

  it("shows every team when the group has no division", async () => {
    serve(matches, pitGroup({ screen: "team_schedule" }));
    renderDisplay();
    await screen.findByTestId("team-row-5");
  });

  it("is registered under team_schedule", () => {
    expect(screenModule("team_schedule").key).toBe("team_schedule");
    expect(screenModule("team_schedule").scrolls).toBe(true);
  });
});

describe("Check-in Status", () => {
  const team = (id: number, number: string, division_id = 4) => ({ id, number, name: `T${id}`, division_id, city: null, state: null, country: null });
  const teams = [team(1, "83897A"), team(2, "10A"), team(3, "9A"), team(4, "7Z", 5)];
  const part = (id: number, team_id: number, checked_in: boolean) => ({ id, session_id: 1, team_id, checked_in });
  const serve = (participants: unknown, group = pitGroup({ screen: "checkin_status", division_id: 4 })) =>
    serveDisplay({
      ...baseRoutes(),
      "/api/divisions": [...DIVISIONS, { id: 5, name: "Division 2" }],
      "/api/teams": teams,
      "/api/displays/me": me(group),
      "/api/sessions/1/participants": () => participants,
    });

  it("shows the totals and a tile per team in number order with its state", async () => {
    serve([part(1, 1, true), part(2, 2, false), part(3, 3, true), part(4, 4, true)]);
    renderDisplay();
    expect(await screen.findByTestId("total-in")).toHaveTextContent("2 / 3");
    expect(screen.getByTestId("total-out")).toHaveTextContent("1 / 3");
    expect(screen.getByRole("heading", { name: "Check-in" })).toBeInTheDocument();
    expect(screen.getByText("Saturday")).toBeInTheDocument();
    const tiles = screen.getAllByTestId(/^checkin-\d+$/);
    expect(tiles.map((t) => t.getAttribute("data-testid"))).toEqual(["checkin-3", "checkin-2", "checkin-1"]);
    expect(tiles.map((t) => t.getAttribute("data-state"))).toEqual(["in", "out", "in"]);
    expect(tiles[0]).toHaveTextContent("9AT3");
  });

  it("updates a tile when participation_changed arrives", async () => {
    let served = [part(1, 1, true), part(2, 2, false), part(3, 3, true)];
    serveDisplay({
      ...baseRoutes(),
      "/api/teams": teams,
      "/api/displays/me": me(pitGroup({ screen: "checkin_status", division_id: 4 })),
      "/api/sessions/1/participants": () => served,
    });
    const { emit } = renderDisplay();
    expect(await screen.findByTestId("total-in")).toHaveTextContent("2 / 3");
    expect(screen.getByTestId("checkin-2")).toHaveAttribute("data-state", "out");
    served = [part(1, 1, true), part(2, 2, true), part(3, 3, true)];
    emit("participation_changed", { session_id: 1 });
    await waitFor(() => expect(screen.getByTestId("checkin-2")).toHaveAttribute("data-state", "in"));
    expect(screen.getByTestId("total-in")).toHaveTextContent("3 / 3");
    expect(screen.getByTestId("total-out")).toHaveTextContent("0 / 3");
  });

  it("lists a team with no participation row as not checked in", async () => {
    serve([part(1, 1, true)]);
    renderDisplay();
    expect(await screen.findByTestId("total-in")).toHaveTextContent("1 / 3");
    expect(screen.getByTestId("total-out")).toHaveTextContent("2 / 3");
    expect(screen.getByTestId("checkin-2")).toHaveAttribute("data-state", "out");
    expect(screen.getByTestId("checkin-3")).toHaveAttribute("data-state", "out");
    expect(screen.queryByTestId("checkin-4")).not.toBeInTheDocument();
  });

  it("lists every team as not checked in before anyone is checked in", async () => {
    serve([]);
    renderDisplay();
    expect(await screen.findByTestId("total-in")).toHaveTextContent("0 / 3");
    expect(screen.getAllByTestId(/^checkin-\d+$/).map((t) => t.getAttribute("data-state"))).toEqual(["out", "out", "out"]);
  });

  it("shows a notice when there are no teams at all", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/teams": [],
      "/api/displays/me": me(pitGroup({ screen: "checkin_status" })),
      "/api/sessions/1/participants": [],
    });
    renderDisplay();
    expect(await screen.findByText("No teams have been added yet")).toBeInTheDocument();
  });

  it("is registered under checkin_status and scrolls", () => {
    expect(screenModule("checkin_status").key).toBe("checkin_status");
    expect(screenModule("checkin_status").scrolls).toBe(true);
  });
});

describe("Schedule by Team without teams", () => {
  it("says there are no teams in the division", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "team_schedule", division_id: 9 })),
      "/api/divisions": [...DIVISIONS, { id: 9, name: "Empty" }],
    });
    renderDisplay();
    expect(await screen.findByText("No teams in this division")).toBeInTheDocument();
  });
});

describe("Schedule by Team solo alliance", () => {
  it("shows the better-ranked team's dot red and the other blue", async () => {
    const solo = match({ id: 7, label: "F1", field_id: 1, scheduled_time: iso(300_000), alliances: [{ id: 71, station: "alliance", team_ids: [1, 2] }] as never });
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "team_schedule", division_id: 4 })),
      "/api/matches?session_id=1": [solo],
      "/api/rankings?session_id=1&division_id=4": [ranking(2, 1), ranking(1, 2)],
    });
    renderDisplay();
    await waitFor(() => expect(screen.getByTestId("next-2-0").querySelector(".side-dot--red")).not.toBeNull());
    expect(screen.getByTestId("next-1-0").querySelector(".side-dot--blue")).not.toBeNull();
  });
});
