import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { PlayingTimesPanel } from "../../src/schedule/PlayingTimesPanel";
import type { PlayingWindowRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});
import { apiRequest } from "@tournament-admin/shared";

const SESSION: SessionRead = { id: 1, event_id: 1, label: "Weekend", session_date: "2026-11-07", timezone: "America/Los_Angeles" };
const WINDOWS: PlayingWindowRead[] = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: "2026-11-07T17:00:00Z", end_utc: "2026-11-07T20:00:00Z" },
  { date: "2026-11-08", start_time: "09:00", end_time: "15:00", start_utc: "2026-11-08T17:00:00Z", end_utc: "2026-11-08T23:00:00Z" },
];

function renderPanel(windows: PlayingWindowRead[], outsideRounds: { roundType: string; locked: boolean }[] = []) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PlayingTimesPanel session={SESSION} windows={windows} timeline={<div>timeline</div>} outsideRounds={outsideRounds} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("PlayingTimesPanel", () => {
  it("summarizes saved windows and shows the timeline", () => {
    renderPanel(WINDOWS);
    expect(screen.getByText("Sat 09:00–12:00 · Sun 09:00–15:00")).toBeInTheDocument();
    expect(screen.getByText("timeline")).toBeInTheDocument();
  });

  it("opens the editor straight away when there are no windows, starting on the session date", () => {
    renderPanel([]);
    expect(screen.getByLabelText("Playing time 1 date")).toHaveValue("2026-11-07");
    expect(screen.getByLabelText("Playing time 1 start")).toHaveValue("09:00");
    expect(screen.getByLabelText("Playing time 1 end")).toHaveValue("12:00");
  });

  it("adds a window that starts where the last one ends, and saves them sorted", async () => {
    vi.mocked(apiRequest).mockResolvedValue([] as never);
    renderPanel(WINDOWS);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Add playing time" }));
    expect(screen.getByLabelText("Playing time 3 start")).toHaveValue("15:00");
    fireEvent.change(screen.getByLabelText("Playing time 3 end"), { target: { value: "16:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1/playing-windows", {
        method: "PUT",
        body: {
          windows: [
            { date: "2026-11-07", start_time: "09:00", end_time: "12:00" },
            { date: "2026-11-08", start_time: "09:00", end_time: "15:00" },
            { date: "2026-11-08", start_time: "15:00", end_time: "16:00" },
          ],
        },
      })
    );
  });

  it("explains an invalid window without saving", () => {
    renderPanel(WINDOWS);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Playing time 1 end"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Each playing time must end after it starts.");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(422, "Set the session's timezone before adding playing times"));
    renderPanel(WINDOWS);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Set the session's timezone before adding playing times");
  });

  it("says which rounds fall outside the playing times", () => {
    renderPanel(WINDOWS, [
      { roundType: "qualification", locked: false },
      { roundType: "practice", locked: true },
    ]);
    expect(screen.getByText(/Some matches are outside the playing times: Qualification\./)).toBeInTheDocument();
    expect(screen.getByText(/Practice has matches outside the playing times but can't be rebuilt/)).toBeInTheDocument();
  });
});
