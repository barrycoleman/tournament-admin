import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SkillsSettingsPanel } from "../../src/skills/SkillsSettingsPanel";
import type { EventRead, SkillsSettingsRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

const TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

function event(game_plugin_name: string | null): EventRead {
  return { id: 1, name: "League", active_session_id: null, game_plugin_name, created_at: "2026-10-08T00:00:00Z" };
}

function stub(
  pluginName: string | null,
  settings: SkillsSettingsRead,
  onPut: (body: unknown) => unknown = (body) => ({ ...settings, ...(body as object) })
) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path === "/api/event") return event(pluginName) as never;
    if (path === "/api/skills/settings" && opts?.method === "PUT") {
      const result = onPut(opts.body);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/skills/settings") return settings as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderPanel() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <SkillsSettingsPanel />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const puts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => (options as { method?: string })?.method === "PUT");

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("SkillsSettingsPanel", () => {
  it("is disabled with the reason before a game plugin is chosen", async () => {
    stub(null, { enabled: false, attempts: {}, types: [] });
    renderPanel();
    expect(
      await screen.findByText("Choose a game plugin above before setting up skills challenges.")
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Run skills challenges" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save skills settings" })).toBeDisabled();
  });

  it("is disabled for a game with no skills types", async () => {
    stub("plain-game", { enabled: false, attempts: {}, types: [] });
    renderPanel();
    expect(await screen.findByText("This game has no skills challenges.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Run skills challenges" })).toBeDisabled();
  });

  it("validates attempts inline and saves the switch and every type", async () => {
    stub("sample_cooperative", { enabled: false, attempts: { autonomous: 3, driver: 3 }, types: TYPES });
    renderPanel();
    const autonomous = await screen.findByLabelText("Autonomous attempts");
    expect(autonomous).toHaveValue("3");
    expect(screen.getByLabelText("Driver attempts")).toHaveValue("3");

    fireEvent.change(autonomous, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skills settings" }));
    expect(await screen.findByText("Enter a whole number from 1 to 20.")).toBeInTheDocument();
    expect(autonomous).toHaveAttribute("aria-invalid", "true");
    expect(puts()).toHaveLength(0);

    fireEvent.change(autonomous, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("switch", { name: "Run skills challenges" }));
    fireEvent.click(screen.getByRole("button", { name: "Save skills settings" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual([
      "/api/skills/settings",
      { method: "PUT", body: { enabled: true, attempts: { autonomous: 5, driver: 3 } } },
    ]);
    expect(await screen.findByText("Skills settings saved.")).toBeInTheDocument();
  });

  it("shows a server refusal", async () => {
    stub(
      "sample_cooperative",
      { enabled: false, attempts: { autonomous: 3, driver: 3 }, types: TYPES },
      () => new ApiError(409, "This game has no skills challenges.")
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("switch", { name: "Run skills challenges" }));
    fireEvent.click(screen.getByRole("button", { name: "Save skills settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This game has no skills challenges.");
  });
});
