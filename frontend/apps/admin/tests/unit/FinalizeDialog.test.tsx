import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { FinalizeDialog } from "../../src/qualification/FinalizeDialog";
import type { QualificationPreview } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

const COOPERATIVE: QualificationPreview = {
  finalized: false,
  game_model: "cooperative_score",
  rows: [
    { played: 7, teams: 4, suggested: 1 },
    { played: 8, teams: 12, suggested: 2 },
  ],
  unplayed_matches: 5,
  blockers: [],
};
const HEAD_TO_HEAD: QualificationPreview = { ...COOPERATIVE, game_model: "head_to_head", rows: [] };

function renderDialog(preview: QualificationPreview, onDone = vi.fn(), onCancel = vi.fn()) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <FinalizeDialog sessionId={1} preview={preview} onDone={onDone} onCancel={onCancel} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  return { onDone, onCancel };
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("FinalizeDialog", () => {
  it("shows one labelled input per row with the suggestion and the unplayed count", () => {
    renderDialog(COOPERATIVE);
    expect(screen.getByRole("alertdialog", { name: "Finalize qualification" })).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.getByRole("spinbutton", { name: "7 played (4 teams)" })).toHaveValue(1);
    expect(screen.getByRole("spinbutton", { name: "8 played (12 teams)" })).toHaveValue(2);
    expect(screen.getByText("5 unplayed matches will be marked Not played.")).toBeInTheDocument();
  });

  it("keeps its rows when a refetch adds a played count while open", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const i18n = initI18n({ en: { translation: enAdmin } });
    const queryClient = new QueryClient();
    const tree = (preview: QualificationPreview) => (
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <FinalizeDialog sessionId={1} preview={preview} onDone={vi.fn()} onCancel={vi.fn()} />
        </I18nextProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(COOPERATIVE));
    rerender(tree({ ...COOPERATIVE, rows: [...COOPERATIVE.rows, { played: 9, teams: 2, suggested: 3 }] }));
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("flags an out-of-range value and disables Finalize", () => {
    renderDialog(COOPERATIVE);
    fireEvent.change(screen.getByRole("spinbutton", { name: "7 played (4 teams)" }), { target: { value: "7" } });
    const message = screen.getByText("Enter a whole number from 0 to 6.");
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: "Finalize" })).toBeDisabled();
  });

  it("sends the drops and reports done", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ id: 1 } as never);
    const { onDone } = renderDialog(COOPERATIVE);
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1/qualification/finalize", {
      method: "POST",
      body: { drops: { "7": 1, "8": 2 } },
    });
  });

  it("renders no inputs for head-to-head and sends empty drops", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ id: 1 } as never);
    const { onDone } = renderDialog(HEAD_TO_HEAD);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(
      screen.getByText("No more qualification matches will be played. Rankings will use the matches played so far.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1/qualification/finalize", {
      method: "POST",
      body: { drops: {} },
    });
  });

  it("shows the server's refusal and stays open", async () => {
    vi.mocked(apiRequest).mockRejectedValue(
      new ApiError(409, "Qualification can't be finalized yet: 1 match in progress")
    );
    const { onDone } = renderDialog(COOPERATIVE);
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    expect(
      await screen.findByText("Qualification can't be finalized yet: 1 match in progress")
    ).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
