import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DashboardRoute } from "../../src/routes/DashboardRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <DashboardRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("DashboardRoute", () => {
  it("shows the event name in an editable field", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByLabelText("Event")).toHaveValue("Regional Qualifier");
  });

  it("renames the event on blur when the value changed", async () => {
    let renameBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/event" && !options) {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/event" && (options as { method?: string })?.method === "PATCH") {
        renameBody = (options as { body: unknown }).body;
        return { id: 1, name: "State Championship", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const input = await screen.findByLabelText("Event");
    fireEvent.change(input, { target: { value: "State Championship" } });
    fireEvent.blur(input);

    await waitFor(() => expect(renameBody).toEqual({ name: "State Championship" }));
  });

  it("does not call the API on blur when the value did not change", async () => {
    const calls: string[] = [];
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      calls.push(path);
      if (path === "/api/event" && !options) {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const input = await screen.findByLabelText("Event");
    fireEvent.blur(input);

    expect(calls.filter((path) => path === "/api/event")).toHaveLength(1);
  });

  it("shows an inline alert with the ApiError detail when the rename is rejected", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/event" && !options) {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/event" && (options as { method?: string })?.method === "PATCH") {
        throw new ApiError(422, "Event name cannot be empty");
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const input = await screen.findByLabelText("Event");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(await screen.findByRole("alert")).toHaveTextContent("Event name cannot be empty");
  });
});
