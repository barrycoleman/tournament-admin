import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { BackupsRoute, type BackupsState } from "../../src/routes/BackupsRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const STATE: BackupsState = {
  folder: "/events/backups/spring",
  folder_is_default: true,
  last_backup_at: "2026-10-12T21:30:05Z",
  last_error: null,
  backups: [
    { filename: "spring-2026-10-12-143005-manual.db", created_at: "2026-10-12T21:30:05Z", reason: "manual", size_bytes: 2048 },
    { filename: "spring-2026-10-12-140000-before-schedule.db", created_at: "2026-10-12T21:00:00Z", reason: "before-schedule", size_bytes: 1_572_864 },
  ],
};

let state: BackupsState;

function stub(overrides: Partial<Record<string, unknown>> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (key === "GET /api/backups") return state as never;
    if (key === "POST /api/backups") return state.backups[0] as never;
    if (key === "PUT /api/backups/folder") return { ...state, folder: "/mnt/usb", folder_is_default: false } as never;
    if (key === "GET /api/time-sync") return { server_time: "x", boot_id: "boot-1" } as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <BackupsRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("BackupsRoute", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    state = structuredClone(STATE);
    stub();
  });

  it("lists backups newest first with their reason and size", async () => {
    renderRoute();
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2
    expect(within(rows[1]).getByText("Back up now (manual)")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2 KB")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Before building a schedule")).toBeInTheDocument();
    expect(within(rows[2]).getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByText("/events/backups/spring")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use default" })).not.toBeInTheDocument();
  });

  it("shows the last error", async () => {
    state.last_error = { message: "No space left on device", at: "2026-10-12T21:35:00Z" };
    renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent("No space left on device");
  });

  it("says when there are no backups yet", async () => {
    state.backups = [];
    state.last_backup_at = null;
    renderRoute();
    expect(await screen.findByText("No backups yet.")).toBeInTheDocument();
  });

  it("backs up now", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/backups", { method: "POST" }));
  });

  it("shows a failed backup's error", async () => {
    stub({ "POST /api/backups": new ApiError(500, "The backup failed: disk full", { detail: "The backup failed: disk full" }) });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("The backup failed: disk full")).toBeInTheDocument();
  });

  it("changes the folder and shows the server's refusal", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Backup folder"), { target: { value: "/mnt/usb" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/backups/folder", { method: "PUT", body: { folder: "/mnt/usb" } })
    );
  });

  it("confirms a restore with the full warning and shows a 409", async () => {
    stub({
      "POST /api/backups/spring-2026-10-12-143005-manual.db/restore": new ApiError(409, "This backup is damaged.", {
        detail: "This backup is damaged.",
      }),
    });
    renderRoute();
    const rows = await screen.findAllByRole("row");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Everything after it is replaced. The current state is saved as a backup first.");
    expect(dialog).toHaveTextContent("Any device, this one included, may need to log in or be admitted again.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(await within(dialog).findByText("This backup is damaged.")).toBeInTheDocument();
  });
});
