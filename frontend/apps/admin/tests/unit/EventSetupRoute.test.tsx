import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n, ApiError } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { EventSetupRoute } from "../../src/routes/EventSetupRoute";
import type { GamePluginChangePreview } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

interface ServerState {
  selected: string | null;
  locked: boolean;
  preview?: GamePluginChangePreview;
  failWith?: string;
}

const EMPTY_PREVIEW: GamePluginChangePreview = {
  would_reset: { skills_enabled: false, session_attempt_overrides: 0, ranking_settings: false },
  awards_needing_attention: [],
};

function mockServer(state: ServerState) {
  const calls: { path: string; method: string }[] = [];
  const eventRead = () => ({
    id: 1, name: "League", active_session_id: null, game_plugin_name: state.selected,
    game_plugin_locked: state.locked, created_at: "",
  });
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: { name?: string } } | undefined;
    const method = opts?.method ?? "GET";
    calls.push({ path, method });
    if (path === "/api/plugins/games") {
      return [
        { name: "example-game", version: "1.0.0", display_name: "Example Game" },
        { name: "second-game", version: "1.0.0", display_name: "Second Game" },
      ] as never;
    }
    if (path === "/api/plugins/schedulers") return [] as never;
    if (path === "/api/server-info") return { port: 8000, addresses: [] } as never;
    if (path.startsWith("/api/event/game-plugin")) {
      const dry = path.endsWith("dry_run=true");
      if (dry && state.failWith) throw new ApiError(409, state.failWith);
      if (dry) return (state.preview ?? EMPTY_PREVIEW) as never;
      state.selected = method === "DELETE" ? null : (opts?.body?.name ?? null);
      return eventRead() as never;
    }
    if (path === "/api/event") return eventRead() as never;
    if (path === "/api/ranking-settings") {
      return {
        session_drop_mode: "tiered", session_drop_count: 1, session_drop_no_show: false, session_drop_dq: false,
        season_keep_best: null, season_only_session_counted: false, season_minimum: 0,
        season_drop_no_show: false, season_drop_dq: false, game_model: null,
      } as never;
    }
    if (path === "/api/skills/settings") {
      return (state.selected
        ? {
            enabled: false,
            attempts: { autonomous: 3, driver: 3 },
            types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
          }
        : { enabled: false, attempts: {}, types: [] }) as never;
    }
    throw new Error(`unexpected request: ${path}`);
  });
  return calls;
}

function renderSetup() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <EventSetupRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("EventSetupRoute", () => {
  it("enables the skills panel as soon as a game plugin is selected, without a reload", async () => {
    let selected: string | null = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      const opts = options as { method?: string; body?: { name?: string } } | undefined;
      if (path === "/api/plugins/games") {
        return [{ name: "sample_cooperative", version: "1.0.0", display_name: "Sample Cooperative Game" }] as never;
      }
      if (path === "/api/plugins/schedulers") return [] as never;
      if (path === "/api/server-info") return { port: 8000, addresses: [] } as never;
      if (path === "/api/event/game-plugin" && opts?.method === "POST") {
        selected = opts.body?.name ?? null;
        return { id: 1, name: "League", active_session_id: null, game_plugin_name: selected, game_plugin_locked: false, created_at: "" } as never;
      }
      if (path === "/api/event") {
        return { id: 1, name: "League", active_session_id: null, game_plugin_name: selected, game_plugin_locked: false, created_at: "" } as never;
      }
      if (path === "/api/ranking-settings") {
        return {
          session_drop_mode: "tiered", session_drop_count: 1, session_drop_no_show: false, session_drop_dq: false,
          season_keep_best: null, season_only_session_counted: false, season_minimum: 0,
          season_drop_no_show: false, season_drop_dq: false, game_model: null,
        } as never;
      }
      if (path === "/api/skills/settings") {
        return (selected
          ? {
              enabled: false,
              attempts: { autonomous: 3, driver: 3 },
              types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
            }
          : { enabled: false, attempts: {}, types: [] }) as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const i18n = initI18n({ en: { translation: enAdmin } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <EventSetupRoute />
        </I18nextProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByRole("switch", { name: "Run skills challenges" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Select for this event" }));

    expect(await screen.findByLabelText("Autonomous attempts")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Run skills challenges" })).toBeEnabled();
    expect(
      screen.queryByText("Choose a game plugin above before setting up skills challenges.")
    ).not.toBeInTheDocument();
  });

  it("puts the game plugin section first and says to choose the game first", async () => {
    mockServer({ selected: null, locked: false });
    renderSetup();
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings[0]).toHaveTextContent("Game plugins");
    expect(headings[0].closest("section")).toHaveAttribute("id", "game-plugins");
    expect(screen.getByText("Choose the game first. Scheduling, matches, rankings and skills depend on it.")).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: "Select for this event" })).toHaveLength(2);
  });

  it("offers switch and clear while the plugin is unused, and confirms with the reset list", async () => {
    const calls = mockServer({
      selected: "example-game",
      locked: false,
      preview: {
        would_reset: { skills_enabled: true, session_attempt_overrides: 2, ranking_settings: true },
        awards_needing_attention: [
          { award_id: 7, session_id: 1, session_label: "Saturday", name: "Driver Champion", reason: "unknown_skills_type" },
        ],
      },
    });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to this" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Switch to Second Game?" });
    expect(dialog).toHaveTextContent("Skills challenges will be turned off.");
    expect(dialog).toHaveTextContent("Skills attempts set for 2 sessions go back to the default.");
    expect(dialog).toHaveTextContent("Ranking settings go back to their defaults.");
    expect(dialog).toHaveTextContent("Saturday: Driver Champion");
    expect(calls.some((c) => c.path === "/api/event/game-plugin?dry_run=true")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch plugin" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/event/game-plugin" && c.method === "POST")).toBe(true)
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Clear selection" })).toBeInTheDocument();
  });

  it("clears the plugin through a dry run and a DELETE", async () => {
    const calls = mockServer({ selected: "example-game", locked: false });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: "Clear selection" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Clear the game plugin?" });
    expect(dialog).toHaveTextContent("No settings need resetting.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear plugin" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/event/game-plugin" && c.method === "DELETE")).toBe(true)
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await screen.findAllByRole("button", { name: "Select for this event" })).toHaveLength(2);
  });

  it("shows the locked note and no switch or clear buttons once the plugin is in use", async () => {
    mockServer({ selected: "example-game", locked: true });
    renderSetup();
    expect(await screen.findByText("Locked because matches are scheduled or skills attempts are recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch to this" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();
  });

  it("shows the server's reason when a switch is refused", async () => {
    mockServer({
      selected: "example-game",
      locked: false,
      failWith: "The game plugin can't be changed after matches are scheduled or skills attempts are recorded.",
    });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to this" }));
    expect(
      await screen.findByText("The game plugin can't be changed after matches are scheduled or skills attempts are recorded.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
