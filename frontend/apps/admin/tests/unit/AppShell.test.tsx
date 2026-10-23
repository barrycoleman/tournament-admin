import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AppShell } from "../../src/components/AppShell";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    apiRequest: vi.fn(async () => ({})),
    useAuth: vi.fn(),
    useRealtimeChannel: vi.fn(),
  };
});

import { apiRequest, useAuth, useRealtimeChannel } from "@tournament-admin/shared";

const SESSIONS = [
  { id: 1, label: "Saturday", session_date: "2026-10-24", timezone: null },
  { id: 2, label: "Undated", session_date: null, timezone: null },
  { id: 3, label: "Friday", session_date: "2026-10-23", timezone: null },
];

function stubAdmin(opts: { activeId: number | null; skillsEnabled?: boolean; plugin?: string | null }) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/event") {
      return {
        id: 1,
        name: "Autumn Open",
        active_session_id: opts.activeId,
        game_plugin_name: opts.plugin === undefined ? "demo" : opts.plugin,
        game_plugin_locked: false,
      } as never;
    }
    if (path === "/api/sessions") return SESSIONS as never;
    if (/^\/api\/sessions\/\d+\/playing-windows$/.test(path)) return [] as never;
    if (path === "/api/skills/settings") return { enabled: opts.skillsEnabled ?? false } as never;
    return {} as never;
  });
}

function asRole(role: "admin" | "front_desk" | "judge") {
  vi.mocked(useAuth).mockReturnValue({
    role,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
  });
}

function renderShell(path = "/") {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <AppShell />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockResolvedValue({} as never);
});

describe("AppShell role-gated navigation", () => {
  it("shows only the Check-In link for the front_desk role", () => {
    asRole("front_desk");
    renderShell();

    expect(screen.getByRole("link", { name: "Check-In" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Divisions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sessions" })).not.toBeInTheDocument();
  });

  it("shows a judge the Awards, Session rankings and Season rankings links only", () => {
    asRole("judge");
    renderShell();

    expect(screen.getByRole("link", { name: "Awards" })).toHaveAttribute("href", "/judge/awards");
    expect(screen.getByRole("link", { name: "Session rankings" })).toHaveAttribute("href", "/judge/rankings");
    expect(screen.getByRole("link", { name: "Season rankings" })).toHaveAttribute("href", "/rankings");
    expect(screen.queryByRole("link", { name: "Teams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Match Control/ })).not.toBeInTheDocument();
  });

  it("shows an admin the game plugin banner while no plugin is chosen", async () => {
    asRole("admin");
    stubAdmin({ activeId: null, plugin: null });
    renderShell();

    expect(
      await screen.findByText("Choose a game plugin to set up scheduling, matches, rankings and skills.")
    ).toBeInTheDocument();
  });
});

describe("AppShell admin menu and header", () => {
  it("groups the admin menu under Event, Sessions and Settings", async () => {
    asRole("admin");
    stubAdmin({ activeId: 3 });
    renderShell();

    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Event",
      "Sessions",
      "Settings",
    ]);
    expect(within(nav).getByRole("link", { name: "Event & game" })).toHaveAttribute("href", "/events/setup");
    expect(within(nav).getByRole("link", { name: "Teams & divisions" })).toHaveAttribute("href", "/teams");
    expect(within(nav).getByRole("link", { name: "Devices & displays" })).toHaveAttribute("href", "/devices");
    expect(within(nav).getByRole("link", { name: "Season rankings" })).toHaveAttribute("href", "/rankings");
    expect(within(nav).getByRole("link", { name: "+ New session" })).toHaveAttribute("href", "/sessions/new");
    expect(within(nav).getByRole("link", { name: "Manage sessions" })).toHaveAttribute("href", "/sessions");
    expect(within(nav).getByRole("link", { name: "Role passwords" })).toHaveAttribute("href", "/settings/roles");
    expect(within(nav).getByRole("link", { name: "Backups" })).toHaveAttribute("href", "/backups");
    expect(within(nav).getByRole("button", { name: "Switch Tournament" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Check-In" })).not.toBeInTheDocument();
    // The switch button left the header.
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Switch Tournament" })).not.toBeInTheDocument();
  });

  it("lists the sessions in date order with an undated one last, Match Control under the active one", async () => {
    asRole("admin");
    stubAdmin({ activeId: 3 });
    renderShell();

    const nav = screen.getByRole("navigation");
    const friday = await within(nav).findByRole("link", { name: "Friday (active)" });
    expect(friday).toHaveAttribute("href", "/sessions/3/today");
    const sessionLinks = within(nav)
      .getAllByRole("link")
      .filter((a) => /^\/sessions\/\d+\/today$/.test(a.getAttribute("href") ?? ""));
    expect(sessionLinks.map((a) => a.getAttribute("href"))).toEqual([
      "/sessions/3/today",
      "/sessions/1/today",
      "/sessions/2/today",
    ]);

    const matchControl = within(nav).getByRole("link", { name: "Match Control" });
    expect(matchControl).toHaveAttribute("href", "/match-control");
    // Directly after the active session's link.
    const links = within(nav).getAllByRole("link");
    expect(links[links.indexOf(friday) + 1]).toBe(matchControl);
    expect(within(nav).queryByRole("link", { name: "Skills Control" })).not.toBeInTheDocument();
  });

  it("shows Skills Control under the active session only when skills are enabled", async () => {
    asRole("admin");
    stubAdmin({ activeId: 3, skillsEnabled: true });
    renderShell();

    const nav = screen.getByRole("navigation");
    expect(await within(nav).findByRole("link", { name: "Skills Control" })).toHaveAttribute("href", "/skills-control");
  });

  it("marks a session's link current on any of its pages", async () => {
    asRole("admin");
    stubAdmin({ activeId: 3 });
    renderShell("/sessions/1/setup");

    const saturday = await screen.findByRole("link", { name: "Saturday" });
    expect(saturday).toHaveClass("active");
    expect(screen.getByRole("link", { name: "Friday (active)" })).not.toHaveClass("active");
    expect(screen.getByRole("link", { name: "Manage sessions" })).not.toHaveClass("active");
  });

  it("shows the event name and an active-session pill in the header", async () => {
    asRole("admin");
    stubAdmin({ activeId: 3 });
    renderShell();

    const header = screen.getByRole("banner");
    expect(await within(header).findByText("Autumn Open")).toBeInTheDocument();
    const pill = await within(header).findByRole("link", { name: /Active: Friday/ });
    expect(pill).toHaveAttribute("href", "/sessions/3/today");
    expect(pill).toHaveClass("badge", "badge-success");
    expect(within(header).getByText(/^\d{2}:\d{2}/)).toBeInTheDocument();
  });

  it("with no active session shows neither control and a neutral pill", async () => {
    asRole("admin");
    stubAdmin({ activeId: null, skillsEnabled: true });
    renderShell();

    expect(await within(screen.getByRole("banner")).findByText("No active session")).toBeInTheDocument();
    const nav = screen.getByRole("navigation");
    expect(await within(nav).findByRole("link", { name: "Friday" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Match Control" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Skills Control" })).not.toBeInTheDocument();
  });

  it("treats an active id missing from the session list as no active session", async () => {
    asRole("admin");
    stubAdmin({ activeId: 99, skillsEnabled: true });
    renderShell();

    expect(await within(screen.getByRole("banner")).findByText("No active session")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Friday" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Match Control" })).not.toBeInTheDocument();
  });

  it("drops the pill and the controls when the active session is cleared live", async () => {
    asRole("admin");
    stubAdmin({ activeId: 3, skillsEnabled: true });
    renderShell();

    expect(await screen.findByRole("link", { name: "Skills Control" })).toBeInTheDocument();
    // Every listener on the admin channel hears the broadcast, as in the browser.
    const listeners = vi
      .mocked(useRealtimeChannel)
      .mock.calls.map((c) => c[0])
      .filter((o) => o.path === "/ws/active-session");
    expect(listeners.length).toBeGreaterThan(0);

    stubAdmin({ activeId: null, skillsEnabled: true });
    await act(async () => {
      for (const listener of listeners) {
        listener.onEvent?.({ event: "active_session_changed", data: { active_session_id: null } } as RealtimeEvent);
      }
    });

    expect(await within(screen.getByRole("banner")).findByText("No active session")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Match Control" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Skills Control" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Friday" })).toBeInTheDocument();
  });
});
