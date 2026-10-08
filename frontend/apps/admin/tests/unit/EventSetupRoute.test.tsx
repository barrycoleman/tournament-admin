import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { EventSetupRoute } from "../../src/routes/EventSetupRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

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
        return { id: 1, name: "League", active_session_id: null, game_plugin_name: selected, created_at: "" } as never;
      }
      if (path === "/api/event") {
        return { id: 1, name: "League", active_session_id: null, game_plugin_name: selected, created_at: "" } as never;
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
});
