import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRoutes, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ranked = [{ team_id: 1, rank: 1, division_id: null, win_points: 2, strength_of_schedule: 0, average_score: 0, matches_played: 1 }];

describe("pit rotation", () => {
  it("moves on from a timed screen after its seconds, and from a list that fits after its seconds too", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/rankings?session_id=1": ranked,
      "/api/displays/me": me(
        pitGroup({
          rotation: [
            { screen: "logo", settings: {}, seconds: 5 },
            { screen: "teamwork_rankings", settings: {}, seconds: 6 },
            { screen: "upcoming_matches", settings: { count: 3, scope: "division" }, seconds: 5 },
          ],
        })
      ),
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_200));
    expect(await screen.findByRole("table", { name: "Teamwork Rankings" })).toBeInTheDocument();
    // The rankings fit (jsdom lays nothing out), so the list's own fit timer moves it on.
    await act(() => vi.advanceTimersByTimeAsync(6_200));
    expect(await screen.findByText("No more matches here")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_200));
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("moves on from a list screen showing its empty notice after the entry's seconds", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(
        pitGroup({
          rotation: [
            { screen: "teamwork_rankings", settings: {}, seconds: 6 },
            { screen: "logo", settings: {}, seconds: 300 },
          ],
        })
      ),
    });
    renderDisplay();
    expect(await screen.findByText("No rankings yet")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(6_200));
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("starts over when the rotation is edited", async () => {
    let group = pitGroup({ rotation: [{ screen: "logo", settings: {}, seconds: 300 }] });
    serveDisplay({ ...baseRoutes(), "/api/rankings?session_id=1": ranked, "/api/displays/me": () => me(group) });
    const { emit } = renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    group = pitGroup({ rotation: [{ screen: "teamwork_rankings", settings: {}, seconds: 20 }] });
    emit("display_changed", { session_id: 1, group_id: 52 });
    expect(await screen.findByRole("table", { name: "Teamwork Rankings" })).toBeInTheDocument();
  });
});
