import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { FrontDeskCheckinRoute } from "../../src/routes/FrontDeskCheckinRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <FrontDeskCheckinRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("FrontDeskCheckinRoute", () => {
  it("shows a clear empty state when no session is active", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No active session — ask an admin to set one."
    );
  });

  it("shows teams and lets you check one in, disabling the button once checked", async () => {
    let postBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: 5, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders" }] as never;
      }
      if (path === "/api/sessions/5/participants" && !options) {
        return [] as never;
      }
      if (path === "/api/sessions/5/participants" && (options as { method?: string })?.method === "POST") {
        postBody = (options as { body: unknown }).body;
        return { id: 1, session_id: 5, team_id: 1, checked_in: true } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText(/1234A/);
    const checkInButton = screen.getByRole("button", { name: "Check In" });
    fireEvent.click(checkInButton);

    await waitFor(() => expect(postBody).toEqual({ team_id: 1, checked_in: true }));
  });

  it("shows an already-checked-in team as checked in from the start", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: 5, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders" }] as never;
      }
      if (path === "/api/sessions/5/participants") {
        return [{ team_id: 1, checked_in: true }] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const checkedButton = await screen.findByRole("button", { name: "Checked In" });
    expect(checkedButton).toBeDisabled();
  });

  it("filters the visible list by the search query", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: 5, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") {
        return [
          { id: 1, number: "1234A", name: "Robo Raiders" },
          { id: 2, number: "5678B", name: "Circuit Breakers" },
        ] as never;
      }
      if (path === "/api/sessions/5/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText(/1234A/);
    fireEvent.change(screen.getByLabelText("Search by team number or name"), {
      target: { value: "5678B" },
    });

    expect(screen.queryByText(/1234A/)).not.toBeInTheDocument();
    expect(screen.getByText(/5678B/)).toBeInTheDocument();
  });

  it("re-fetches the active session when the realtime channel reports it changed", async () => {
    let capturedOnEvent: ((event: { event: string; data: unknown }) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      capturedOnEvent = options.onEvent as typeof capturedOnEvent;
      return { connected: true };
    });

    let eventCallCount = 0;
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        eventCallCount += 1;
        const activeSessionId = eventCallCount === 1 ? 5 : 9;
        return {
          id: 1,
          name: "Regional Qualifier",
          active_session_id: activeSessionId,
          game_plugin_name: null,
          created_at: "2026-01-01T00:00:00Z",
        } as never;
      }
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders" }] as never;
      }
      if (path === "/api/sessions/5/participants" || path === "/api/sessions/9/participants") {
        return [] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText(/1234A/);
    expect(eventCallCount).toBe(1);

    expect(capturedOnEvent).toBeDefined();
    fireEvent.change(screen.getByLabelText("Search by team number or name"), {
      target: { value: "" },
    });
    // Firing an unrelated event type must NOT trigger a re-fetch.
    capturedOnEvent?.({ event: "something_else", data: {} });
    await waitFor(() => expect(eventCallCount).toBe(1));

    capturedOnEvent?.({ event: "active_session_changed", data: { active_session_id: 9 } });

    await waitFor(() => expect(eventCallCount).toBe(2));
  });
});
