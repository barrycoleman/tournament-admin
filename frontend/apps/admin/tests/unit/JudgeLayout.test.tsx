import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useOutletContext } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { JudgeLayout } from "../../src/routes/JudgeLayout";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

function Probe() {
  const { session, channelPath } = useOutletContext<{ session: { label: string }; channelPath: string }>();
  return <p>{`${session.label} on ${channelPath}`}</p>;
}

function renderAt(activeSessionId: number | null) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/event") return { id: 1, name: "League", active_session_id: activeSessionId } as never;
    if (path === "/api/sessions") return [{ id: 5, event_id: 1, label: "Saturday" }] as never;
    throw new Error(`unexpected request: ${path}`);
  });
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/judge", element: <JudgeLayout />, children: [{ path: "awards", element: <Probe /> }] }],
    { initialEntries: ["/judge/awards"] }
  );
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("JudgeLayout", () => {
  it("gives its pages the active session and the active-session channel", async () => {
    renderAt(5);
    expect(await screen.findByText("Saturday on /ws/active-session")).toBeInTheDocument();
  });

  it("says so when no session is active", async () => {
    renderAt(null);
    expect(await screen.findByText("No session is active. Ask an admin to set the active session.")).toBeInTheDocument();
  });
});
