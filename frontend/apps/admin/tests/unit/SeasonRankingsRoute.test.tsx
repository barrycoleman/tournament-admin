import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SeasonRankingsRoute } from "../../src/routes/SeasonRankingsRoute";
import type { RankingRead, RankingSettingsRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SETTINGS: RankingSettingsRead = {
  session_drop_mode: "tiered",
  session_drop_count: 1,
  session_drop_no_show: false,
  session_drop_dq: false,
  season_keep_best: null,
  season_only_session_counted: false,
  season_minimum: 0,
  season_drop_no_show: false,
  season_drop_dq: false,
  game_model: "cooperative_score",
};
const ROW: RankingRead = {
  session_id: null,
  division_id: null,
  team_id: 1,
  rank: 1,
  win_points: 0,
  strength_of_schedule: 0,
  average_score: 30,
  matches_played: 4,
};

function stub(settings: Partial<RankingSettingsRead> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/ranking-settings") return { ...SETTINGS, ...settings } as never;
    if (path === "/api/divisions") return [] as never;
    if (path === "/api/teams") return [{ id: 1, number: "101", name: "Alpha", division_id: null }] as never;
    if (path === "/api/rankings?event_wide=true") return [ROW] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderSeason() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SeasonRankingsRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SeasonRankingsRoute", () => {
  it("shows season rankings under a selected Teamwork tab", async () => {
    stub();
    renderSeason();

    expect(await screen.findByRole("row", { name: /Alpha/ })).toHaveTextContent("30.00");
    expect(screen.getByRole("heading", { name: "Season rankings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Teamwork" })).toHaveAttribute("aria-selected", "true");
  });

  it("describes default cooperative rules as a plain average", async () => {
    stub();
    renderSeason();
    expect(await screen.findByText("Average of every qualification match.")).toBeInTheDocument();
  });

  it("describes non-default season rules", async () => {
    stub({ season_keep_best: 24, season_minimum: 24, season_only_session_counted: true });
    renderSeason();
    expect(
      await screen.findByText("Best 24 matches · minimum 24 · only matches counted in a session ranking")
    ).toBeInTheDocument();
  });

  it("shows no rules line for head-to-head", async () => {
    stub({ game_model: "head_to_head" });
    renderSeason();
    await screen.findByRole("row", { name: /Alpha/ });
    expect(screen.queryByText("Average of every qualification match.")).not.toBeInTheDocument();
  });

  it("refetches on event-wide ranking updates only", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    stub();
    renderSeason();
    await screen.findByRole("row", { name: /Alpha/ });

    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    const fetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/rankings?event_wide=true").length;
    const before = fetches();
    const settingsFetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/ranking-settings").length;
    const settingsBefore = settingsFetches();
    act(() => onEvent?.({ event: "ranking_updated", data: { session_id: 3, event_wide: false } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetches()).toBe(before);
    expect(settingsFetches()).toBe(settingsBefore);

    act(() => onEvent?.({ event: "ranking_updated", data: { session_id: null, event_wide: true } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
    await waitFor(() => expect(settingsFetches()).toBeGreaterThan(settingsBefore));
  });
});
