import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import type { FinalsBracket } from "../../src/display/api";
import { createEventBus } from "../../src/display/events";
import { ScorerApp } from "../../src/scorer/ScorerApp";

afterEach(() => vi.restoreAllMocks());

const team = (id: number, number: string) => ({
  id, number, name: `Team ${number}`, division_id: null, city: null, state: null, country: null,
});
const ranking = (team_id: number, rank: number) => ({
  team_id, rank, division_id: null, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 0,
});

function bracket(selection: FinalsBracket["selection"], status = "selecting_alliances"): FinalsBracket {
  return {
    id: 5, session_id: 1, division_id: null, field_set_id: 10, format: "single_elimination", bracket_size: 4,
    status, alliance_selection: "captain_pick", alliances: [], runs: [], results: [], matchups: [], selection,
  };
}
const free = {
  captain_team_id: 1, invitable_team_ids: [3, 4], declined_team_ids: [2], pending_team_id: null,
  alliances_formed: 0, alliances_target: 2, last_step: null,
};
const pending = { ...free, invitable_team_ids: [3], pending_team_id: 4 };

const ALL_FINALS = "/api/finals?session_id=1&all_divisions=true";

function serve(
  finals: () => FinalsBracket[],
  post?: (url: string) => Response,
  { activeSessionId = 1 as number | null, divisions = [] as { id: number; name: string }[] } = {}
) {
  const posts: { url: string; body: unknown }[] = [];
  const routes: Record<string, unknown> = {
    "/api/event": { id: 1, name: "E", active_session_id: activeSessionId, game_plugin_name: null },
    "/api/divisions": divisions,
    "/api/teams": [team(1, "101A"), team(2, "102B"), team(3, "103C"), team(4, "104D")],
    "/api/rankings?session_id=1": [ranking(1, 1), ranking(2, 2), ranking(3, 3), ranking(4, 4)],
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return post ? post(url) : new Response(JSON.stringify(finals()[0]), { status: 200 });
    }
    // The server's default (no division_id) lists only brackets without a division.
    if (url === ALL_FINALS) return new Response(JSON.stringify(finals()), { status: 200 });
    if (url === "/api/finals?session_id=1")
      return new Response(JSON.stringify(finals().filter((b) => b.division_id === null)), { status: 200 });
    if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
  });
  return { posts, spy };
}

function renderScorer(role = "scorer") {
  const bus = createEventBus();
  render(
    <ScorerApp
      accessToken="tok"
      device={{ id: 7, name: "Tablet 1", role, status: "active" }}
      bus={bus}
      unreachable={false}
    />
  );
  return { bus };
}

describe("Scorer shell picking screen", () => {
  it("shows the home screen when there is no bracket", async () => {
    serve(() => []);
    renderScorer();
    expect(await screen.findByText("Tablet 1")).toBeInTheDocument();
    expect(screen.queryByTestId("picking-screen")).not.toBeInTheDocument();
  });

  it("shows the captain and the invitable teams, and a tap invites", async () => {
    const { posts } = serve(() => [bracket(free)]);
    renderScorer();
    expect(await screen.findByText("Alliance 1 · Captain")).toBeInTheDocument();
    expect(screen.getByTestId("captain-number")).toHaveTextContent("101A");
    expect(screen.getByText("Who do you invite?")).toBeInTheDocument();
    const declined = screen.getByTestId("pick-team-102B");
    expect(declined).toBeDisabled();
    expect(declined).toHaveClass("is-declined");
    expect(screen.getByTestId("pick-team-103C")).toHaveTextContent("#3");
    fireEvent.click(screen.getByTestId("pick-team-103C"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/finals/5/selection/invite", body: { team_id: 3 } });
  });

  it("accepts and declines the pending invite with its team id", async () => {
    const { posts } = serve(() => [bracket(pending)]);
    renderScorer("referee");
    expect(await screen.findByTestId("invitee-number")).toHaveTextContent("104D");
    expect(screen.getByText("101A invites")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("accept-invite"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/finals/5/selection/accept", body: { team_id: 4 } });
    fireEvent.click(screen.getByTestId("decline-invite"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ url: "/api/finals/5/selection/decline", body: { team_id: 4 } });
    fireEvent.click(screen.getByTestId("cancel-invite"));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].url).toBe("/api/finals/5/selection/cancel");
  });

  it("shows a notice and refetches on a 409", async () => {
    const { spy } = serve(
      () => [bracket(pending)],
      () => new Response(JSON.stringify({ detail: "No invite is open." }), { status: 409 })
    );
    renderScorer();
    fireEvent.click(await screen.findByTestId("accept-invite"));
    expect(await screen.findByText("Someone else just answered — updated.")).toBeInTheDocument();
    await waitFor(() =>
      expect(spy.mock.calls.filter(([u, i]) => String(u) === ALL_FINALS && !i?.method).length).toBeGreaterThan(1)
    );
  });

  it("shows the picking screen for a bracket in one division of a multi-division event", async () => {
    const divided = { ...bracket(free), division_id: 3 };
    serve(() => [divided], undefined, { divisions: [{ id: 3, name: "Red" }, { id: 4, name: "Blue" }] });
    renderScorer();
    expect(await screen.findByTestId("picking-screen")).toBeInTheDocument();
    expect(screen.getByTestId("captain-number")).toHaveTextContent("101A");
  });

  it("asks for no finals when there is no active session", async () => {
    const { spy } = serve(() => [bracket(free)], undefined, { activeSessionId: null });
    renderScorer();
    expect(await screen.findByText("Tablet 1")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(spy.mock.calls.some(([u]) => String(u).startsWith("/api/finals"))).toBe(false);
    expect(screen.queryByTestId("picking-screen")).not.toBeInTheDocument();
  });

  it("says it is waiting for the organiser when there is no captain", async () => {
    serve(() => [bracket({ ...free, captain_team_id: null })]);
    renderScorer();
    expect(await screen.findByText("Waiting for the organiser…")).toBeInTheDocument();
    expect(screen.queryByTestId("captain-number")).not.toBeInTheDocument();
    expect(screen.queryByText("Who do you invite?")).not.toBeInTheDocument();
  });

  it("says it is waiting for the organiser when no team can be invited", async () => {
    serve(() => [bracket({ ...free, invitable_team_ids: [], declined_team_ids: [2] })]);
    renderScorer();
    expect(await screen.findByText("Waiting for the organiser…")).toBeInTheDocument();
    expect(screen.queryByText("Who do you invite?")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pick-team-102B")).not.toBeInTheDocument();
  });

  it("switches both ways on finals_changed", async () => {
    let current: FinalsBracket[] = [];
    serve(() => current);
    const { bus } = renderScorer();
    await screen.findByText("Tablet 1");
    current = [bracket(free)];
    act(() => bus.emit({ event: "finals_changed", data: {} }));
    expect(await screen.findByTestId("picking-screen")).toBeInTheDocument();
    current = [bracket(null, "in_progress")];
    act(() => bus.emit({ event: "finals_changed", data: {} }));
    expect(await screen.findByText("Tablet 1")).toBeInTheDocument();
    expect(screen.queryByTestId("picking-screen")).not.toBeInTheDocument();
  });
});
