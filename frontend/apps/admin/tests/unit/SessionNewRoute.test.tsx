import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionNewRoute } from "../../src/routes/SessionNewRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";
const mock = vi.mocked(apiRequest);

const RealDateTimeFormat = Intl.DateTimeFormat;

beforeEach(() => {
  mock.mockReset();
  // Only the browser-zone lookup (no arguments) is faked; formatting a date
  // in a named zone still uses the real implementation.
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) =>
    args.length === 0
      ? { resolvedOptions: () => ({ timeZone: "Asia/Tokyo" }) }
      : new RealDateTimeFormat(...args)) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/sessions/new"]}>
          <Routes>
            <Route path="/sessions/new" element={<SessionNewRoute />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SessionNewRoute", () => {
  it("defaults the timezone to the browser's and opens the new session's setup after saving", async () => {
    let body: unknown = null;
    mock.mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions") {
        body = (options as { body: unknown }).body;
        return { id: 7, label: "Sat" } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const zone = screen.getByLabelText("Timezone") as HTMLSelectElement;
    expect(zone.value).toBe("Asia/Tokyo");
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Sat" } });
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/sessions/7/setup"));
    expect(body).toEqual({ label: "Sat", session_date: "2026-11-01", timezone: "Asia/Tokyo" });
  });

  it("defaults the date to today in the selected timezone and labels it without (optional)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 20:00 UTC on Nov 9 is already Nov 10 in Tokyo, but still Nov 9 in Los Angeles.
    vi.setSystemTime(new Date("2026-11-09T20:00:00Z"));
    try {
      renderRoute();
      const date = screen.getByLabelText("Date");
      expect(date).toHaveValue("2026-11-10");
      expect(screen.queryByText(/optional/)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "America/Los_Angeles" } });
      expect(date).toHaveValue("2026-11-09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a date the admin chose when the timezone changes", () => {
    renderRoute();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-12-05" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "America/Los_Angeles" } });
    expect(screen.getByLabelText("Date")).toHaveValue("2026-12-05");
  });
});
