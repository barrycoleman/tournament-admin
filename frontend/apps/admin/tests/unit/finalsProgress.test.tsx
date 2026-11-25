import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { bracket, renderFinals, stubReads } from "./finalsPicking.helpers";
import type { FinalsBracket } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";

const ALLIANCES = [
  { id: 1, seed: 1, team_ids: [1, 2], unavailable: false },
  { id: 2, seed: 2, team_ids: [3, 4], unavailable: true },
];
const writes: { path: string; options?: { method?: string } }[] = [];

function show(finals: FinalsBracket) {
  vi.mocked(apiRequest).mockImplementation(
    stubReads(
      () => [finals],
      (path, options) => {
        writes.push({ path, options });
        return finals;
      }
    )
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
  writes.length = 0;
});

describe("finals in progress", () => {
  it("lists alliances with seeds and teams and links to Match Control", async () => {
    show(bracket({ alliances: ALLIANCES }));
    renderFinals();
    expect(await screen.findByText("Finals are in progress.")).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /Team 1/ });
    expect(within(row).getByText("Team 2", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Match Control" })).toHaveAttribute("href", "/match-control");
    expect(screen.getByText("Can't play")).toBeInTheDocument();
  });

  it("marks an alliance can't play only after confirming", async () => {
    show(bracket({ alliances: ALLIANCES }));
    renderFinals();
    fireEvent.click(await screen.findByRole("button", { name: "Can't play" }));
    expect(writes).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/forfeits/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Alliance can't play" }));
    await waitFor(() =>
      expect(writes).toContainEqual(
        expect.objectContaining({
          path: "/api/finals/9/alliances/1/unavailable",
          options: expect.objectContaining({ method: "POST" }),
        })
      )
    );
  });

  it("starts over only after confirming", async () => {
    show(bracket({ alliances: ALLIANCES }));
    renderFinals();
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));
    expect(writes).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
    await waitFor(() =>
      expect(writes).toContainEqual(
        expect.objectContaining({ path: "/api/finals/9", options: expect.objectContaining({ method: "DELETE" }) })
      )
    );
  });

  it("offers neither Start over nor Can't play when complete", async () => {
    show(bracket({ status: "complete", alliances: ALLIANCES }));
    renderFinals();
    expect(await screen.findByText("Finals are complete.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Can't play" })).not.toBeInTheDocument();
  });

  it("offers no Can't play in score chase", async () => {
    show(bracket({ format: "score_chase", alliances: ALLIANCES }));
    renderFinals();
    await screen.findByText("Finals are in progress.");
    expect(screen.queryByRole("button", { name: "Can't play" })).not.toBeInTheDocument();
  });

  it.each(["score_saved", "new_match_created"])("refetches the finals on %s", async (name) => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      if (options.path === "/ws/session/1") onEvent = options.onEvent;
      return { connected: true };
    });
    show(bracket({ alliances: ALLIANCES }));
    renderFinals();
    await screen.findByText("Finals are in progress.");
    vi.mocked(apiRequest).mockClear();
    onEvent!({ event: name, data: { session_id: 1 } } as RealtimeEvent);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/finals?session_id=1"));
  });
});
