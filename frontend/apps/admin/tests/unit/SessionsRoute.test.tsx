import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionsRoute } from "../../src/routes/SessionsRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SessionsRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SessionsRoute", () => {
  it("lists existing sessions", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: "2026-09-05", timezone: "America/Los_Angeles" },
        ] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByText("Saturday")).toBeInTheDocument();
    expect(screen.getByText("2026-09-05")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
  });

  it("creates a new session", async () => {
    let createBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) return [] as never;
      if (path === "/api/sessions" && (options as { method?: string })?.method === "POST") {
        createBody = (options as { body: unknown }).body;
        return { id: 2, event_id: 1, label: "Sunday", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByRole("button", { name: "Add session..." });
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Sunday" } });
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    await waitFor(() =>
      expect(createBody).toEqual({ label: "Sunday", session_date: null, timezone: null })
    );
  });

  it("edits an existing session", async () => {
    let patchBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null },
        ] as never;
      }
      if (path === "/api/sessions/1" && (options as { method?: string })?.method === "PATCH") {
        patchBody = (options as { body: unknown }).body;
        return { id: 1, event_id: 1, label: "Renamed", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchBody).toEqual({ label: "Renamed", session_date: null, timezone: null })
    );
  });

  it("shows an inline error on a failed create", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) return [] as never;
      if (path === "/api/sessions" && (options as { method?: string })?.method === "POST") {
        throw new ApiError(422, "Label cannot be empty");
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByRole("button", { name: "Add session..." });
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Label cannot be empty");
  });
});
