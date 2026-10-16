import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audienceGroup, baseRoutes, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("display mode", () => {
  it("shows its own name when it has no group in the active session", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(null) });
    renderDisplay();
    expect(await screen.findByText("Not set up for this session")).toBeInTheDocument();
    expect(screen.getByText("Big TV")).toBeInTheDocument();
  });

  it("says so when no session is running", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(null, null) });
    renderDisplay();
    expect(await screen.findByText("No session is running")).toBeInTheDocument();
  });

  it("shows the event name on the Logo screen", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup()) });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("an unknown screen key falls back to Logo", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "future_screen" })) });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("re-reads its setup on display_changed and active_session_changed", async () => {
    let current: unknown = me(null);
    serveDisplay({ ...baseRoutes(), "/api/displays/me": () => current });
    const { emit } = renderDisplay();
    expect(await screen.findByText("Not set up for this session")).toBeInTheDocument();
    current = me(pitGroup());
    emit("display_changed", { session_id: 1, group_id: 52 });
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
    current = me(null, null);
    emit("active_session_changed", { active_session_id: null });
    expect(await screen.findByText("No session is running")).toBeInTheDocument();
  });

  it("shows its name for 10 seconds when identified", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup()) });
    const { emit } = renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    emit("display_identify", { device_id: 7 });
    expect(screen.getByTestId("identify")).toHaveTextContent("Big TV");
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(screen.getByTestId("identify")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.queryByTestId("identify")).not.toBeInTheDocument();
  });

  it("keeps its picture and shows a corner badge while the server is unreachable", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup()) });
    renderDisplay({ unreachable: true });
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });

  it("waits, then retries, when its setup can't be read", async () => {
    let fail = true;
    const routes = baseRoutes();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/displays/me") {
        return fail ? new Response("{}", { status: 503 }) : new Response(JSON.stringify(me(null)), { status: 200 });
      }
      if (url === "/api/time-sync") {
        return new Response(JSON.stringify({ server_time: new Date().toISOString(), boot_id: "b" }), { status: 200 });
      }
      return new Response(JSON.stringify(routes[url] ?? {}), { status: 200 });
    });
    renderDisplay();
    expect(await screen.findByText("Connecting…")).toBeInTheDocument();
    fail = false;
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(await screen.findByText("Not set up for this session")).toBeInTheDocument();
  });
});
