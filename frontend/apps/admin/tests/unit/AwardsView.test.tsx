import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AwardsView } from "../../src/awards/AwardsView";
import type { AwardRead, SessionAwardsRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 5,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
  has_scored_matches: false,
  qualification_finalized_at: null,
  qualification_drops: null,
};

export function award(overrides: Partial<AwardRead> = {}): AwardRead {
  return {
    id: 1,
    session_id: 5,
    position: 0,
    name: "Excellence Award",
    description: "Top all-round team",
    kind: "judged",
    scope: "event",
    division_ids: [],
    source: null,
    skills_type: null,
    basis: null,
    placement: null,
    slots: [
      {
        division_id: null,
        division_name: null,
        status: "judged_pending",
        winners: [],
        override_reason: null,
        note: null,
        moved_team_ids: [],
      },
    ],
    ...overrides,
  };
}

const CHAMPION = award({
  id: 2,
  position: 1,
  name: "Teamwork Champion",
  description: null,
  kind: "performance",
  scope: "division",
  source: "finals",
  basis: "session",
  placement: 1,
  slots: [
    {
      division_id: 7,
      division_name: "Rookie",
      status: "provisional",
      winners: [{ team_id: 1, number: "101", name: "Alpha", organization: null }],
      override_reason: null,
      note: null,
      moved_team_ids: [],
    },
  ],
});

let awards: SessionAwardsRead;

function stub() {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === "/api/sessions/5/awards" && !options?.method) return awards as never;
    if (path === "/api/sessions/5/awards/team-history") return [] as never;
    if (path === "/api/divisions") return [{ id: 7, event_id: 1, name: "Rookie", target_team_count: null }] as never;
    if (path === "/api/teams") return [{ id: 1, number: "101", name: "Alpha", division_id: 7 }] as never;
    if (path === "/api/sessions/5/participants") return [{ team_id: 1, checked_in: true }] as never;
    if (path === "/api/sessions") return [SESSION, { ...SESSION, id: 6, label: "Sunday" }] as never;
    if (path === "/api/skills/settings") return { enabled: false, attempts: {}, types: [] } as never;
    if (options?.method) return {} as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderView(mode: "admin" | "judge" = "admin") {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <AwardsView session={SESSION} mode={mode} channelPath="/ws/session/5" /> },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
  awards = { awards_finalized_at: null, awards: [award(), CHAMPION] };
  stub();
});

describe("AwardsView", () => {
  it("lists awards in order with their rule, slots and status badges", async () => {
    renderView();
    const cards = await screen.findAllByRole("article");
    expect(cards.map((card) => within(card).getByRole("heading").textContent)).toEqual([
      "Excellence Award",
      "Teamwork Champion",
    ]);
    expect(within(cards[0]).getByText("Top all-round team")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Judged · event-wide")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Pending")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Performance · Finals placement 1 · this session · per division")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Provisional")).toBeInTheDocument();
    expect(within(cards[1]).getByText("101 Alpha")).toBeInTheDocument();
  });

  it("listens on the given channel and refetches on award and result events", async () => {
    renderView();
    await screen.findAllByRole("article");
    const options = vi.mocked(useRealtimeChannel).mock.calls[0][0];
    expect(options.path).toBe("/ws/session/5");
    vi.mocked(apiRequest).mockClear();
    options.onEvent?.({ event: "score_saved", data: {} });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/sessions/5/awards"));
  });

  it("moves an award down by sending the new order", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Move Excellence Award down" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/5/awards/order", {
        method: "PUT",
        body: { award_ids: [2, 1] },
      })
    );
    expect(screen.getByRole("button", { name: "Move Excellence Award up" })).toBeInTheDocument();
  });

  it("adds a judged award from the form", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Add award" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Add award" });
    fireEvent.change(within(dialog).getByLabelText("Award name"), { target: { value: "Design Award" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save award" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/5/awards", {
        method: "POST",
        body: expect.objectContaining({ name: "Design Award", kind: "judged", scope: "division" }),
      })
    );
  });

  it("hides finals and teamwork ranking for an event-wide performance award", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Add award" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Add award" });
    fireEvent.click(within(dialog).getByLabelText("Performance"));
    fireEvent.click(within(dialog).getByLabelText("Event-wide (one winner)"));
    const options = within(within(dialog).getByLabelText("Winner comes from")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Overall skills", "Skills type"]);
  });

  it("deletes an award after confirming", async () => {
    renderView();
    const card = (await screen.findAllByRole("article"))[0];
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete award" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/awards/1", { method: "DELETE" }));
  });

  it("copies awards from another session", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Copy awards from…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Copy awards" });
    await within(dialog).findByRole("option", { name: "Sunday" });
    fireEvent.change(within(dialog).getByLabelText("Copy from session"), { target: { value: "6" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/5/awards/copy", {
        method: "POST",
        body: { from_session_id: 6 },
      })
    );
  });

  it("shows the finalized banner and disables editing", async () => {
    awards = { ...awards, awards_finalized_at: "2026-10-10T18:00:00Z" };
    renderView();
    expect(await screen.findByText(/Awards finalized on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add award" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Edit" })[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unfinalize" })).toBeEnabled();
  });

  it("shows only judged awards and no admin controls in judge mode", async () => {
    renderView("judge");
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Add award" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finalize awards" })).not.toBeInTheDocument();
  });
});
