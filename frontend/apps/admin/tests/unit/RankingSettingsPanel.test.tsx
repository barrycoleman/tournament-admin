import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { RankingSettingsPanel } from "../../src/rankings/RankingSettingsPanel";
import type { GameModel, RankingSettingsRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

function settings(game_model: GameModel | null): RankingSettingsRead {
  return {
    session_drop_mode: "tiered",
    session_drop_count: 1,
    session_drop_no_show: false,
    session_drop_dq: false,
    season_keep_best: null,
    season_only_session_counted: false,
    season_minimum: 0,
    season_drop_no_show: false,
    season_drop_dq: false,
    game_model,
  };
}

function stub(gameModel: GameModel | null, onPut: (body: unknown) => unknown = (body) => body) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path === "/api/ranking-settings" && opts?.method === "PUT") {
      const result = onPut(opts.body);
      if (result instanceof Error) throw result;
      return { ...(result as object), game_model: gameModel } as never;
    }
    if (path === "/api/ranking-settings") return settings(gameModel) as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderPanel() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RankingSettingsPanel />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const puts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => (options as { method?: string })?.method === "PUT");

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("RankingSettingsPanel", () => {
  it("renders nothing for a head-to-head event", async () => {
    stub("head_to_head");
    const { container } = renderPanel();
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/ranking-settings"));
    expect(container).toBeEmptyDOMElement();
  });

  it("enables the drop count only for dropping a set number", async () => {
    stub("cooperative_score");
    renderPanel();
    const count = await screen.findByLabelText("Matches to drop");
    expect(count).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Drop a set number of lowest matches"));
    expect(count).toBeEnabled();
  });

  it("blocks a minimum above the kept matches without saving", async () => {
    stub("cooperative_score");
    renderPanel();
    const season = await screen.findByRole("group", { name: "Season rankings" });
    fireEvent.change(within(season).getByLabelText("Keep best matches"), { target: { value: "2" } });
    fireEvent.change(within(season).getByLabelText("Minimum matches"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByText("Minimum can't be more than the number of matches kept.")).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("rejects a decimal number of kept matches", async () => {
    stub("cooperative_score");
    renderPanel();
    const season = await screen.findByRole("group", { name: "Season rankings" });
    fireEvent.change(within(season).getByLabelText("Keep best matches"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByText("Enter a whole number of 1 or more, or leave blank.")).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("shows the server's message when the save is refused", async () => {
    stub("cooperative_score", () => new ApiError(422, "season_minimum cannot be more than season_keep_best"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "season_minimum cannot be more than season_keep_best"
    );
  });

  it("saves the form as the settings body", async () => {
    let saved: unknown = null;
    stub("cooperative_score", (body) => {
      saved = body;
      return body;
    });
    renderPanel();
    const sessionGroup = await screen.findByRole("group", { name: "Session rankings" });
    const season = screen.getByRole("group", { name: "Season rankings" });
    fireEvent.click(within(sessionGroup).getByLabelText("Drop a set number of lowest matches"));
    fireEvent.change(within(sessionGroup).getByLabelText("Matches to drop"), { target: { value: "2" } });
    fireEvent.click(within(sessionGroup).getByLabelText("DQs can be dropped"));
    fireEvent.change(within(season).getByLabelText("Keep best matches"), { target: { value: "24" } });
    fireEvent.click(within(season).getByLabelText("Only use matches counted in a session ranking"));
    fireEvent.change(within(season).getByLabelText("Minimum matches"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByText("Settings saved. Rankings recalculated.")).toBeInTheDocument();
    expect(saved).toEqual({
      session_drop_mode: "lowest",
      session_drop_count: 2,
      session_drop_no_show: false,
      session_drop_dq: true,
      season_keep_best: 24,
      season_only_session_counted: true,
      season_minimum: 20,
      season_drop_no_show: false,
      season_drop_dq: false,
    });
  });
});
