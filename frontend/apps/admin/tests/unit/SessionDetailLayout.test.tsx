import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionDetailLayout } from "../../src/routes/SessionDetailLayout";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

function renderAt(path: string) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/sessions/:sessionId",
        element: <SessionDetailLayout />,
        children: [{ path: "checkin", element: <p>checkin tab content</p> }],
      },
    ],
    { initialEntries: [path] }
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SessionDetailLayout", () => {
  it("renders the session's header, meta line, and tab strip once loaded", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: "2026-09-05", timezone: "America/Los_Angeles" },
        ] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderAt("/sessions/1/checkin");

    expect(await screen.findByRole("heading", { name: "Saturday" })).toBeInTheDocument();
    expect(screen.getByText(/2026-09-05/)).toBeInTheDocument();
    expect(screen.getByText(/America\/Los_Angeles/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check-In" })).toBeInTheDocument();
  });

  it("shows the not-found message when the id isn't in a successfully-loaded list", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderAt("/sessions/999/checkin");

    expect(await screen.findByRole("alert")).toHaveTextContent("Session not found.");
  });

  it("shows the generic error message (not 'not found') when the sessions fetch itself fails", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") throw new ApiError(500, "Internal Server Error");
      throw new Error(`unexpected request: ${path}`);
    });
    renderAt("/sessions/1/checkin");

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});
