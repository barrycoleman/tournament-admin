import { screen, within } from "@testing-library/react";
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
  it("shows the group's next match with ranks, names and locations", async () => {
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
    expect(await screen.findByRole("heading", { name: "Qualification 9" })).toBeInTheDocument();
    expect(screen.getByText("Field 2")).toBeInTheDocument();
    expect(screen.getByTestId("start")).toHaveTextContent("2:00 to go");
    const blue = screen.getByRole("region", { name: "Blue alliance" });
    expect(within(blue).getByText("103C")).toBeInTheDocument();
    expect(within(blue).getByText("Bolts")).toBeInTheDocument();
    expect(within(blue).getByText("Shelbyville")).toBeInTheDocument();
    expect(within(blue).getByTestId("rank-3")).toHaveTextContent("2");
    expect(within(screen.getByRole("region", { name: "Red alliance" })).getByTestId("rank-1")).toHaveTextContent("–");
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
    expect(await screen.findByRole("heading", { name: "Qualification 12" })).toBeInTheDocument();
  });

  it("uses one Alliance band for a cooperative game", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(audienceGroup({ screen: "match_intro" })),
      "/api/matches?session_id=1": [match({ scheduled_time: iso(60_000) })],
    });
    renderDisplay();
    const band = await screen.findByRole("region", { name: "Alliance" });
    expect(within(band).getByText("101A")).toBeInTheDocument();
    expect(within(band).getByText("104D")).toBeInTheDocument();
  });

  it("says when no match is left", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "match_intro" })) });
    renderDisplay();
    expect(await screen.findByText("No more matches here")).toBeInTheDocument();
  });
});

describe("Last Scored Match", () => {
  it("shows each alliance's score and the score breakdown", async () => {
    const scored = match({ id: 20, label: "Q20", match_number: 20, status: "completed", phase: "ended" });
    serveDisplay({
      ...baseRoutes(),
      "/api/event/scoresheet-schema": SCHEMA,
      "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
      "/api/matches?session_id=1": [scored],
      "/api/scores?session_id=1": [
        { match_id: 20, alliance_id: 201, score: 19, data: { high_balls: 3, parked: true, auto_winner: "red" }, teams: [], saved_at: iso(-5_000) },
        { match_id: 20, alliance_id: 202, score: 4, data: { high_balls: 1, parked: false, auto_winner: "red" }, teams: [], saved_at: iso(-5_000) },
      ],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Qualification 20" })).toBeInTheDocument();
    expect(screen.getByTestId("score-red")).toHaveTextContent("19");
    expect(screen.getByTestId("score-blue")).toHaveTextContent("4");
    const breakdown = screen.getByRole("table", { name: "Score breakdown" });
    const parked = within(breakdown).getByRole("row", { name: /Robot Parked/ });
    expect(parked).toHaveTextContent("✓");
    expect(parked).toHaveTextContent("–");
    expect(within(breakdown).getByRole("row", { name: /High Balls/ })).toHaveTextContent("3");
  });

  it("waits for data, then says when nothing is scored yet", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/scoresheet-schema": SCHEMA,
      "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
    });
    renderDisplay();
    expect(await screen.findByText("No match has been scored yet")).toBeInTheDocument();
  });
});
