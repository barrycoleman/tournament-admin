import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, audienceGroup, baseRoutes, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const SCHEMA = [
  { name: "high_balls", label: "High Balls", data_type: "integer", options: null },
  { name: "parked", label: "Robot Parked", data_type: "boolean", options: null },
  { name: "auto_winner", label: "Autonomous Winner", data_type: "enum", options: ["red", "blue", "tie"] },
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Match Intro", () => {
  it("shows one row per team by side with rank, number, name and place, and the match in the bottom bar", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "match_intro" })),
      "/api/matches?session_id=1": [
        match({ id: 9, label: "Q9", match_number: 9, field_id: 2, scheduled_time: iso(120_000) }),
        match({ id: 8, label: "Q8", match_number: 8, phase: "driver", scheduled_time: iso(0) }),
      ],
      "/api/rankings?session_id=1": [{ team_id: 3, division_id: null, rank: 2, win_points: 2, strength_of_schedule: 0, average_score: 0, matches_played: 1 }],
    });
    renderDisplay();
    const bar = await screen.findByTestId("bottom-bar");
    expect(bar).toHaveTextContent("Up next · Qualification 9");
    expect(bar).toHaveTextContent("Field 2");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByTestId("start")).toHaveTextContent("Starts in2:00");
    const blue = screen.getByTestId("intro-blue");
    const bolts = within(blue).getByTestId("intro-team-3");
    expect(bolts).toHaveTextContent("103C");
    expect(bolts).toHaveTextContent("Bolts");
    expect(bolts).toHaveTextContent("Shelbyville");
    await waitFor(() => expect(within(bolts).getByTestId("rank-3")).toHaveTextContent("#2"));
    const red = screen.getByTestId("intro-red");
    expect(within(red).getByTestId("rank-1")).toHaveTextContent("–");
    expect(within(red).getByTestId("intro-team-1")).toHaveTextContent("Springfield, IL");
    expect(within(red).getByTestId("intro-team-2")).toHaveTextContent("102B");
    expect(within(blue).queryByText("101A")).not.toBeInTheDocument();
  });

  it("shows the queued match instead when one is queued", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "match_intro", field_set: { queued_match_id: 12, timeout_deadline: null } })),
      "/api/matches?session_id=1": [
        match({ id: 11, label: "Q11", match_number: 11, scheduled_time: iso(60_000) }),
        match({ id: 12, label: "Q12", match_number: 12, scheduled_time: iso(120_000) }),
      ],
    });
    renderDisplay();
    expect(await screen.findByTestId("bottom-bar")).toHaveTextContent("Up next · Qualification 12");
  });

  it("shows one team on each side for a cooperative game", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(audienceGroup({ screen: "match_intro" })),
      "/api/matches?session_id=1": [
        match({
          scheduled_time: iso(60_000),
          alliances: [
            { id: 1001, station: "red", team_ids: [1] },
            { id: 1002, station: "blue", team_ids: [4] },
          ],
        }),
      ],
    });
    renderDisplay();
    const red = await screen.findByTestId("intro-red");
    const blue = screen.getByTestId("intro-blue");
    expect(within(red).getByText("101A")).toBeInTheDocument();
    expect(within(red).queryByText("104D")).not.toBeInTheDocument();
    expect(within(blue).getByText("104D")).toBeInTheDocument();
  });

  it("puts the better-ranked team of a score-chase run on the red side", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(audienceGroup({ screen: "match_intro" })),
      "/api/matches?session_id=1": [
        match({ scheduled_time: iso(60_000), alliances: [{ id: 1001, station: "solo", team_ids: [1, 4] }] }),
      ],
      "/api/rankings?session_id=1": [
        { team_id: 1, division_id: null, rank: 5, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 },
        { team_id: 4, division_id: null, rank: 2, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 },
      ],
    });
    renderDisplay();
    await waitFor(() => expect(within(screen.getByTestId("intro-red")).getByText("104D")).toBeInTheDocument());
    expect(within(screen.getByTestId("intro-blue")).getByText("101A")).toBeInTheDocument();
  });

  it("says when no match is left", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "match_intro" })) });
    renderDisplay();
    expect(await screen.findByText("No more matches here")).toBeInTheDocument();
  });
});

const scoreRow = (alliance: number, score: number) => ({ match_id: 20, alliance_id: alliance, score, data: { high_balls: 3 }, teams: [], saved_at: iso(-5_000) });
const scored = () => match({ id: 20, label: "Q20", match_number: 20, status: "completed", phase: "ended" });

function serveResult(scores: unknown[], extra: Record<string, unknown> = {}) {
  serveDisplay({
    ...baseRoutes(),
    "/api/event/scoresheet-schema": SCHEMA,
    "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
    "/api/matches?session_id=1": [scored()],
    "/api/scores?session_id=1": scores,
    ...extra,
  });
}

describe("Last Scored Match", () => {
  it("shows red's and blue's scores with the winner tagged and the loser dimmed, and no breakdown", async () => {
    serveResult([scoreRow(201, 48), scoreRow(202, 52)]);
    renderDisplay();
    expect(await screen.findByTestId("bottom-bar")).toHaveTextContent("Result · Qualification 20");
    expect(screen.getByTestId("score-red")).toHaveTextContent("48");
    expect(screen.getByTestId("score-blue")).toHaveTextContent("52");
    const red = screen.getByTestId("result-red");
    const blue = screen.getByTestId("result-blue");
    expect(within(blue).getByTestId("winner")).toHaveTextContent("Winner");
    expect(within(red).queryByTestId("winner")).not.toBeInTheDocument();
    expect(red).toHaveClass("is-loser");
    expect(blue).not.toHaveClass("is-loser");
    expect(within(red).getByText("101A")).toBeInTheDocument();
    expect(within(red).getByText("102B")).toBeInTheDocument();
    expect(within(blue).getByText("103C")).toBeInTheDocument();
    expect(screen.queryByText("High Balls")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("tags the red side when it wins", async () => {
    serveResult([scoreRow(201, 60), scoreRow(202, 10)]);
    renderDisplay();
    await screen.findByTestId("result-red");
    expect(within(screen.getByTestId("result-red")).getByTestId("winner")).toBeInTheDocument();
    expect(screen.getByTestId("result-blue")).toHaveClass("is-loser");
  });

  it("shows no winner and dims nothing for a tie", async () => {
    serveResult([scoreRow(201, 30), scoreRow(202, 30)]);
    renderDisplay();
    await screen.findByTestId("result-red");
    expect(screen.getByTestId("score-red")).toHaveTextContent("30");
    expect(screen.getByTestId("score-blue")).toHaveTextContent("30");
    expect(screen.queryByTestId("winner")).not.toBeInTheDocument();
    expect(screen.getByTestId("result-red")).not.toHaveClass("is-loser");
    expect(screen.getByTestId("result-blue")).not.toHaveClass("is-loser");
  });

  it("shows both team blocks and one combined score for a cooperative game", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
      "/api/matches?session_id=1": [
        match({
          id: 20, label: "Q20", match_number: 20, status: "completed", phase: "ended",
          alliances: [
            { id: 201, station: "red", team_ids: [1] },
            { id: 202, station: "blue", team_ids: [4] },
          ],
        }),
      ],
      "/api/scores?session_id=1": [scoreRow(201, 42), scoreRow(202, 42)],
    });
    renderDisplay();
    expect(await screen.findByTestId("score-combined")).toHaveTextContent("42");
    expect(screen.queryByTestId("score-red")).not.toBeInTheDocument();
    expect(screen.queryByTestId("winner")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("result-red")).getByText("101A")).toBeInTheDocument();
    expect(within(screen.getByTestId("result-blue")).getByText("104D")).toBeInTheDocument();
    expect(screen.getByTestId("result-red")).not.toHaveClass("is-loser");
    expect(screen.getByTestId("result-blue")).not.toHaveClass("is-loser");
  });

  it("waits for data, then says when nothing is scored yet", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
    });
    renderDisplay();
    expect(await screen.findByText("No match has been scored yet")).toBeInTheDocument();
  });
});
