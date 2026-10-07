import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { QualificationBar } from "../../src/qualification/QualificationBar";
import type { QualificationPreview, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel, ApiError } from "@tournament-admin/shared";

const OPEN: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
  has_scored_matches: true,
  qualification_finalized_at: null,
  qualification_drops: null,
};
const FINALIZED: SessionRead = { ...OPEN, qualification_finalized_at: "2026-10-07T18:00:00Z", qualification_drops: {} };

function preview(blockers: QualificationPreview["blockers"]): QualificationPreview {
  return { finalized: false, game_model: "head_to_head", rows: [], unplayed_matches: 0, blockers };
}

function renderBar(session: SessionRead, blockers: QualificationPreview["blockers"] = []) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/sessions/1/qualification/finalize-preview") return preview(blockers) as never;
    throw new Error(`unexpected request: ${path}`);
  });
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <QualificationBar session={session} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  return { invalidate };
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("QualificationBar", () => {
  it("offers Finalize when nothing blocks it", async () => {
    renderBar(OPEN);
    const button = screen.getByRole("button", { name: "Finalize qualification" });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("disables Finalize and explains the blockers", async () => {
    renderBar(OPEN, [
      { code: "in_progress", count: 2 },
      { code: "ended_unscored", count: 1 },
    ]);
    const button = screen.getByRole("button", { name: "Finalize qualification" });
    expect(await screen.findByText("2 matches are in progress.")).toBeInTheDocument();
    expect(screen.getByText("1 match has ended but has no score.")).toBeInTheDocument();
    expect(button).toBeDisabled();
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)).toHaveTextContent("2 matches are in progress.");
    expect(document.getElementById(described!)).toHaveTextContent("1 match has ended but has no score.");
  });

  it("shows a finalized session and reopens it after confirmation", async () => {
    renderBar(FINALIZED);
    expect(screen.getByText("Qualification finalized on Oct 7, 2026, 11:00 AM. Finals can now be generated.")).toBeInTheDocument();
    vi.mocked(apiRequest).mockResolvedValue({ id: 1 } as never);
    fireEvent.click(screen.getByRole("button", { name: "Reopen qualification" }));
    const dialog = screen.getByRole("alertdialog", { name: "Reopen qualification?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen qualification" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1/qualification/reopen", { method: "POST" })
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("explains a failed preview and retries it", async () => {
    const i18n = initI18n({ en: { translation: enAdmin } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(500, "Preview exploded"));
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <QualificationBar session={OPEN} />
        </I18nextProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText("Preview exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalize qualification" })).toBeDisabled();
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue(preview([]) as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1/qualification/finalize-preview"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Finalize qualification" })).toBeEnabled());
    expect(screen.queryByText("Preview exploded")).not.toBeInTheDocument();
  });

  it("shows the server's reason when reopening is refused", async () => {
    renderBar(FINALIZED);
    vi.mocked(apiRequest).mockRejectedValue(
      new ApiError(409, "Delete this session's finals brackets before reopening qualification")
    );
    fireEvent.click(screen.getByRole("button", { name: "Reopen qualification" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen qualification" }));
    expect(
      await screen.findByText("Delete this session's finals brackets before reopening qualification")
    ).toBeInTheDocument();
  });

  it("refreshes on qualification_status_changed", async () => {
    const { invalidate } = renderBar(OPEN);
    expect(useRealtimeChannel).toHaveBeenCalledWith(expect.objectContaining({ path: "/ws/session/1" }));
    const { onEvent } = vi.mocked(useRealtimeChannel).mock.calls[0][0];
    onEvent?.({ event: "qualification_status_changed", data: { session_id: 1, finalized: true } } as RealtimeEvent);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["sessions"]);
    expect(keys).toContainEqual(["matches", 1]);
    expect(keys).toContainEqual(["qualification-preview", 1]);
  });
});
