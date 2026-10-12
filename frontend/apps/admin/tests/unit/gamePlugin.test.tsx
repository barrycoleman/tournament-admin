import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { NeedsGamePlugin, RequiresGamePlugin } from "../../src/gamePlugin/NeedsGamePlugin";
import { GamePluginBanner } from "../../src/gamePlugin/GamePluginBanner";
import { handleGamePluginEvent } from "../../src/gamePlugin/liveUpdates";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useAuth: vi.fn() };
});

import { apiRequest, useAuth } from "@tournament-admin/shared";

function event(name: string | null) {
  return { id: 1, name: "League", active_session_id: null, game_plugin_name: name, game_plugin_locked: false, created_at: "" };
}

function renderAt(ui: React.ReactNode, path = "/") {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function asRole(role: string) {
  vi.mocked(useAuth).mockReturnValue({ role } as never);
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("NeedsGamePlugin", () => {
  it("tells an admin where to choose one", () => {
    asRole("admin");
    renderAt(<NeedsGamePlugin />);
    expect(screen.getByText(/This needs a game plugin\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose one in Event Setup" })).toHaveAttribute(
      "href",
      "/events/setup#game-plugins"
    );
  });

  it("tells other roles the organizer hasn't chosen one, with no link", () => {
    asRole("judge");
    renderAt(<NeedsGamePlugin />);
    expect(screen.getByText("The organizer hasn't chosen a game plugin yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("RequiresGamePlugin", () => {
  it("shows the panel instead of the screen when no plugin is chosen", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    renderAt(<RequiresGamePlugin><p>Matches grid</p></RequiresGamePlugin>);
    expect(await screen.findByText(/This needs a game plugin\./)).toBeInTheDocument();
    expect(screen.queryByText("Matches grid")).not.toBeInTheDocument();
  });

  it("shows the screen once a plugin is chosen", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event("example-game") as never);
    renderAt(<RequiresGamePlugin><p>Matches grid</p></RequiresGamePlugin>);
    expect(await screen.findByText("Matches grid")).toBeInTheDocument();
  });
});

describe("GamePluginBanner", () => {
  it("shows for an admin while no plugin is chosen", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    renderAt(<GamePluginBanner />, "/teams");
    expect(
      await screen.findByText("Choose a game plugin to set up scheduling, matches, rankings and skills.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a game plugin" })).toHaveAttribute("href", "/events/setup#game-plugins");
  });

  it("is hidden on Event Setup, once a plugin is chosen, and for other roles", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    const setup = renderAt(<GamePluginBanner />, "/events/setup");
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(screen.queryByText(/Choose a game plugin to set up/)).not.toBeInTheDocument();
    setup.unmount();

    vi.mocked(apiRequest).mockResolvedValue(event("example-game") as never);
    const chosen = renderAt(<GamePluginBanner />, "/teams");
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(screen.queryByText(/Choose a game plugin to set up/)).not.toBeInTheDocument();
    chosen.unmount();

    asRole("judge");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    renderAt(<GamePluginBanner />, "/teams");
    expect(screen.queryByText(/Choose a game plugin to set up/)).not.toBeInTheDocument();
  });
});

describe("handleGamePluginEvent", () => {
  it("refetches everything that depends on the plugin", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handleGamePluginEvent(queryClient, { event: "game_plugin_changed", data: { game_plugin_name: "x" } });
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of ['["event"]', '["matchFormat"]', '["awards"]', '["rankings"]', '["skillsRankings"]', '["sessionSkills"]']) {
      expect(keys).toContain(key);
    }
  });

  it("ignores other events", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handleGamePluginEvent(queryClient, { event: "score_saved", data: {} });
    expect(spy).not.toHaveBeenCalled();
  });
});
