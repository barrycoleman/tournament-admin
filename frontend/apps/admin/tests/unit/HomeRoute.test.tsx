import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { HomeRoute } from "../../src/routes/HomeRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";
const mock = vi.mocked(apiRequest);

beforeEach(() => {
  mock.mockReset();
});

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}</p>;
}

function setup(data: { plugin: string | null; teams: unknown[]; sessions: unknown[]; activeId?: number | null }) {
  mock.mockImplementation(async (path: string) => {
    if (path === "/api/event")
      return { id: 1, name: "E", active_session_id: data.activeId ?? null, game_plugin_name: data.plugin } as never;
    if (path === "/api/teams") return data.teams as never;
    if (path === "/api/sessions") return data.sessions as never;
    if (path.endsWith("/playing-windows")) return [] as never;
    throw new Error(`unexpected request: ${path}`);
  });
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("HomeRoute", () => {
  it("shows the checklist with three failing rows for an empty event", async () => {
    setup({ plugin: null, teams: [], sessions: [] });
    expect(await screen.findByRole("heading", { level: 1, name: "Get your event ready" })).toBeInTheDocument();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    items.forEach((item) => expect(item).toHaveTextContent("✗"));
    expect(screen.getByRole("link", { name: "Choose the game" })).toHaveAttribute("href", "/events/setup#game-plugins");
    expect(screen.getByRole("link", { name: "Add teams" })).toHaveAttribute("href", "/teams");
    expect(screen.getByRole("link", { name: "Create the first session" })).toHaveAttribute("href", "/sessions/new");
  });

  it("keeps finished items in the list, ticked", async () => {
    setup({ plugin: "g", teams: [{ id: 1 }], sessions: [] });
    await screen.findByRole("heading", { level: 1 });
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("✓");
    expect(items[1]).toHaveTextContent("✓");
    expect(items[2]).toHaveTextContent("✗");
  });

  it("opens today's session when the event is set up", async () => {
    setup({
      plugin: "g",
      teams: [{ id: 1 }],
      sessions: [
        { id: 3, label: "A", session_date: "2020-01-01", timezone: "UTC" },
        { id: 5, label: "B", session_date: "2020-01-02", timezone: "UTC" },
      ],
      activeId: 5,
    });
    expect(await screen.findByTestId("where")).toHaveTextContent("/sessions/5/today");
  });
});
