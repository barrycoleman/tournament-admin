import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { MakeActiveDialog } from "../../src/orientation/MakeActiveDialog";
import type { SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const target = { id: 2, label: "Sunday" } as SessionRead;
const displays = (id: number, has_setup: boolean) => ({ session_id: id, groups: [], unassigned: [], has_setup });

let calls: string[];

function stub(opts: {
  targetSetup: boolean;
  sourceSetup: boolean;
  matches?: unknown[];
  failOn?: string;
  holdTargetDisplays?: Promise<void>;
}) {
  calls = [];
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (options?.method && options.method !== "GET") {
      calls.push(key);
      if (key === opts.failOn) throw new ApiError(409, "Server says no.");
      return {} as never;
    }
    const routes: Record<string, unknown> = {
      "GET /api/event": { id: 1, name: "E", active_session_id: 1 },
      "GET /api/sessions": [{ id: 1, label: "Saturday" }, target],
      "GET /api/matches?session_id=1": opts.matches ?? [],
      "GET /api/displays?session_id=1": displays(1, opts.sourceSetup),
      "GET /api/displays?session_id=2": displays(2, opts.targetSetup),
    };
    if (key === "GET /api/displays?session_id=2") await opts.holdTargetDisplays;
    if (key in routes) return routes[key] as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderDialog(onClose = vi.fn(), onActivated = vi.fn()) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MakeActiveDialog targetSession={target} onClose={onClose} onActivated={onActivated} />
      </QueryClientProvider>
    </I18nextProvider>
  );
  return { onClose, onActivated };
}

async function enabledButton(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("MakeActiveDialog", () => {
  it("offers to copy TV spots, copying before activating", async () => {
    stub({ targetSetup: false, sourceSetup: true });
    const { onActivated } = renderDialog();
    fireEvent.click(await enabledButton("Copy TV spots and make active"));
    expect(screen.getByRole("button", { name: "Make active without copying" })).toBeInTheDocument();
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
    expect(calls).toEqual([
      "POST /api/sessions/2/copy-displays",
      "POST /api/event/active-session",
    ]);
    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith("/api/sessions/2/copy-displays", {
      method: "POST",
      body: { source_session_id: 1 },
    });
  });

  it("makes active without copying", async () => {
    stub({ targetSetup: false, sourceSetup: true });
    const { onActivated } = renderDialog();
    fireEvent.click(await enabledButton("Make active without copying"));
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
    expect(calls).toEqual(["POST /api/event/active-session"]);
  });

  it("offers only Make active when neither session has TV spots", async () => {
    stub({ targetSetup: false, sourceSetup: false });
    renderDialog();
    expect(await enabledButton("Make active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("warns which match is running on the active session", async () => {
    stub({ targetSetup: true, sourceSetup: true, matches: [{ id: 5, label: "Q7", phase: "driver" }] });
    renderDialog();
    expect(await screen.findByText("Q7 is running on Saturday.")).toBeInTheDocument();
  });

  it("calls neither endpoint on Cancel", async () => {
    stub({ targetSetup: false, sourceSetup: true });
    const { onClose } = renderDialog();
    await screen.findByRole("button", { name: "Make active without copying" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("holds the actions until the displays data has resolved", async () => {
    let release!: () => void;
    stub({ targetSetup: false, sourceSetup: true, holdTargetDisplays: new Promise<void>((r) => (release = r)) });
    renderDialog();
    expect(await screen.findByRole("button", { name: "Make active" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Make active" }));
    expect(calls).toEqual([]);
    release();
    expect(await enabledButton("Copy TV spots and make active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make active" })).not.toBeInTheDocument();
  });

  it("shows the server's message and stays open when activating fails", async () => {
    stub({ targetSetup: false, sourceSetup: false, failOn: "POST /api/event/active-session" });
    const { onClose, onActivated } = renderDialog();
    fireEvent.click(await enabledButton("Make active"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server says no.");
    expect(onActivated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Make active" })).toBeEnabled();
  });

  it("does not activate when copying the TV spots fails", async () => {
    stub({ targetSetup: false, sourceSetup: true, failOn: "POST /api/sessions/2/copy-displays" });
    const { onActivated } = renderDialog();
    fireEvent.click(await enabledButton("Copy TV spots and make active"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server says no.");
    expect(calls).toEqual(["POST /api/sessions/2/copy-displays"]);
    expect(onActivated).not.toHaveBeenCalled();
  });
});
