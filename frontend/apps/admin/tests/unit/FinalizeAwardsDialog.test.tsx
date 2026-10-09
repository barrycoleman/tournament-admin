import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { FinalizeAwardsDialog } from "../../src/awards/FinalizeAwardsDialog";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockImplementation(async (_path: string, options?: { body?: unknown }) => {
    return {
      awards_finalized_at: (options?.body as { confirm?: boolean } | undefined)?.confirm ? "2026-10-10T18:00:00Z" : null,
      warnings: [
        { award_id: 1, award_name: "Excellence Award", division_id: null, division_name: null, status: "judged_pending" },
        { award_id: 2, award_name: "Champion", division_id: 8, division_name: "Open", status: "no_result" },
      ],
    } as never;
  });
});

function renderDialog() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <FinalizeAwardsDialog sessionId={5} onClose={onClose} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  return onClose;
}

describe("FinalizeAwardsDialog", () => {
  it("shows the dry run's warnings, then finalizes on confirm", async () => {
    const onClose = renderDialog();
    expect(await screen.findByText("Excellence Award (Event): Pending")).toBeInTheDocument();
    expect(screen.getByText("Champion (Open): No result yet")).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledWith("/api/sessions/5/awards/finalize", { method: "POST", body: { confirm: false } });
    fireEvent.click(screen.getByRole("button", { name: "Finalize awards" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/5/awards/finalize", { method: "POST", body: { confirm: true } })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("disables confirm while it is sending, so a double click finalizes once", async () => {
    renderDialog();
    const confirm = await screen.findByRole("button", { name: "Finalize awards" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        vi.mocked(apiRequest).mock.calls.filter(([, o]) => (o as { body?: { confirm?: boolean } })?.body?.confirm)
      ).toHaveLength(1)
    );
  });
});
