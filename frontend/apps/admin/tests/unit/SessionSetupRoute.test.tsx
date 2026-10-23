import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionSetupRoute } from "../../src/routes/SessionSetupRoute";
import { ReadinessChecklist } from "../../src/schedule/ReadinessChecklist";
import type { SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});
import { apiRequest } from "@tournament-admin/shared";
const mock = vi.mocked(apiRequest);

const SESSION = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
  live_scores_qualification: true,
  live_scores_finals: false,
  has_scored_matches: false,
  qualification_finalized_at: null,
  qualification_drops: null,
} as SessionRead;

function stub() {
  mock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === "PATCH") return SESSION as never;
    if (path.startsWith("/api/field-sets") || path.startsWith("/api/fields")) return [] as never;
    if (path === "/api/divisions") return [] as never;
    if (path === "/api/sessions") return [SESSION] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderSetup(session: SessionRead, entry = "/setup") {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/", element: <Outlet context={{ session }} />, children: [{ path: "setup", element: <SessionSetupRoute /> }] }],
    { initialEntries: [entry] }
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mock.mockReset();
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
    () => ({ resolvedOptions: () => ({ timeZone: "Asia/Tokyo" }) }) as never
  );
  stub();
});

describe("SessionSetupRoute", () => {
  it("shows the session's values", async () => {
    renderSetup(SESSION);
    expect(await screen.findByLabelText("Session name")).toHaveValue("Saturday");
    expect(screen.getByLabelText("Date (optional)")).toHaveValue("2026-11-07");
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/Los_Angeles");
    expect(screen.queryByText(/we suggested/)).not.toBeInTheDocument();
  });

  it("suggests the browser timezone, with a hint, when none is saved", async () => {
    renderSetup({ ...SESSION, timezone: null });
    expect(await screen.findByLabelText("Timezone")).toHaveValue("Asia/Tokyo");
    expect(screen.getByText("Not saved yet: we suggested your computer's timezone.")).toBeInTheDocument();
  });

  it("saves all five fields with a PATCH", async () => {
    renderSetup({ ...SESSION, timezone: null });
    fireEvent.click(await screen.findByLabelText("Show live scores on displays in finals"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith("/api/sessions/1", {
        method: "PATCH",
        body: {
          label: "Saturday",
          session_date: "2026-11-07",
          timezone: "Asia/Tokyo",
          live_scores_qualification: true,
          live_scores_finals: true,
        },
      })
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("renders the fields panel under #fields", async () => {
    const { container } = renderSetup(SESSION);
    await screen.findByLabelText("Session name");
    expect(container.querySelector("section#fields")).not.toBeNull();
  });

  it("does not pull focus back to the hash target after a save refetch", async () => {
    renderSetup(SESSION, "/setup#session-timezone");
    const select = await screen.findByLabelText("Timezone");
    await waitFor(() => expect(select).toHaveFocus());
    const label = screen.getByLabelText("Session name");
    label.focus();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    await waitFor(() => expect(mock.mock.calls.filter((c) => c[0] === "/api/sessions").length).toBeGreaterThan(0));
    expect(select).not.toHaveFocus();
  });

  it("hides the suggestion hint once the timezone is changed", async () => {
    renderSetup({ ...SESSION, timezone: null });
    fireEvent.change(await screen.findByLabelText("Timezone"), { target: { value: "Europe/Paris" } });
    expect(screen.queryByText(/we suggested/)).not.toBeInTheDocument();
  });

  it("scrolls to and focuses the timezone select for #session-timezone", async () => {
    renderSetup(SESSION, "/setup#session-timezone");
    const select = await screen.findByLabelText("Timezone");
    await waitFor(() => expect(select).toHaveFocus());
  });
});

describe("readiness links", () => {
  it("send the timezone and fields fixes to the Setup tab", () => {
    const i18n = initI18n({ en: { translation: enAdmin } });
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <I18nextProvider i18n={i18n}>
            <ReadinessChecklist
              sessionId={1}
              items={[
                { key: "timezone", ok: false },
                { key: "fields", ok: false },
              ] as never}
            />
          </I18nextProvider>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/sessions/1/setup#session-timezone", "/sessions/1/setup#fields"]);
  });
});
