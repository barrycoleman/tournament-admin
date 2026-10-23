import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { ActiveSessionBanner } from "../../src/orientation/ActiveSessionBanner";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

// Saturday (active) plays 09:00-17:00 UTC on the 24th; the next session plays
// 09:00-17:00 UTC on the 25th, so the cutover is at 01:00 UTC on the 25th.
const SATURDAY_WINDOW = { date: "2026-10-24", start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T17:00:00Z" };
const SUNDAY_WINDOW = { date: "2026-10-25", start_utc: "2026-10-25T09:00:00Z", end_utc: "2026-10-25T17:00:00Z" };
const CUTOVER = new Date("2026-10-25T01:00:00Z").getTime();

// Each test offers a different session id, since a snooze lives for the page.
function stub(nextId: number) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    const routes: Record<string, unknown> = {
      "/api/event": { id: 1, name: "E", active_session_id: 1, game_plugin_name: "demo", game_plugin_locked: false },
      "/api/sessions": [
        { id: 1, label: "Saturday", session_date: "2026-10-24", timezone: "UTC" },
        { id: nextId, label: "Sunday", session_date: "2026-10-25", timezone: "UTC" },
        { id: 500, label: "Undated", session_date: null, timezone: null },
      ],
      "/api/sessions/1/playing-windows": [SATURDAY_WINDOW],
      [`/api/sessions/${nextId}/playing-windows`]: [SUNDAY_WINDOW],
      "/api/sessions/500/playing-windows": [],
      "/api/matches?session_id=1": [],
      "/api/displays?session_id=1": { session_id: 1, groups: [], unassigned: [], has_setup: false },
      [`/api/displays?session_id=${nextId}`]: { session_id: nextId, groups: [], unassigned: [], has_setup: false },
    };
    if (path in routes) return routes[path] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderBanner() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ActiveSessionBanner />
      </QueryClientProvider>
    </I18nextProvider>
  );
}

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** Lets the queries settle without moving the faked clock. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ActiveSessionBanner", () => {
  it("is hidden before the cutover and appears once it passes", async () => {
    stub(2);
    vi.setSystemTime(CUTOVER - 20_000);
    renderBanner();
    await settle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await tick(30_000);
    const banner = await screen.findByRole("status");
    expect(banner).toHaveClass("alert", "alert-warning", "active-session-banner");
    expect(banner).toHaveTextContent(/Sunday is scheduled to start at 09:00/);
    expect(banner).toHaveTextContent("Make it the active session? The TVs and Match Control will switch to it.");
  });

  it("hides on Not yet and comes back after 15 minutes", async () => {
    stub(3);
    vi.setSystemTime(CUTOVER);
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Not yet" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await tick(14 * 60_000);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await tick(60_000);
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("still hides on Not yet when storage throws", async () => {
    stub(4);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.setSystemTime(CUTOVER);
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Not yet" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens the make-active dialog for the offered session", async () => {
    stub(5);
    vi.setSystemTime(CUTOVER);
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Make it active" }));
    expect(await screen.findByRole("heading", { name: "Make Sunday active?" })).toBeInTheDocument();
  });
});
