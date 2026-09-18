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
  it("shows the event name as read-only text with an edit action", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByText("Regional Qualifier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit event name" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Event")).not.toBeInTheDocument();
  });

  it("renames the event when Save is clicked after editing", async () => {
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

    await screen.findByText("Regional Qualifier");
    fireEvent.click(screen.getByRole("button", { name: "Edit event name" }));
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "State Championship" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(renameBody).toEqual({ name: "State Championship" }));
    expect(await screen.findByText("State Championship")).toBeInTheDocument();
  });

  it("does not call the API when Save is clicked with an unchanged value", async () => {
    const calls: string[] = [];
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      calls.push(path);
      if (path === "/api/event" && !options) {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Regional Qualifier");
    fireEvent.click(screen.getByRole("button", { name: "Edit event name" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(calls.filter((path) => path === "/api/event")).toHaveLength(1);
  });

  it("clicking Cancel discards the edit without calling the API", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Regional Qualifier");
    fireEvent.click(screen.getByRole("button", { name: "Edit event name" }));
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "Something else" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Regional Qualifier")).toBeInTheDocument();
    expect(screen.queryByLabelText("Event")).not.toBeInTheDocument();
  });

  it("shows an inline alert with the ApiError detail when the rename is rejected, staying in edit mode", async () => {
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

    await screen.findByText("Regional Qualifier");
    fireEvent.click(screen.getByRole("button", { name: "Edit event name" }));
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Event name cannot be empty");
    // Stays in edit mode so the user can fix and retry.
    expect(screen.getByLabelText("Event")).toBeInTheDocument();
  });
});
