import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@tournament-admin/shared";
import { bracket, renderFinals, stubReads } from "./finalsPicking.helpers";
import type { FinalsBracket, FinalsSelection } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

function selection(overrides: Partial<FinalsSelection> = {}): FinalsSelection {
  return {
    captain_team_id: 3,
    invitable_team_ids: [4, 5, 6, 7, 8],
    declined_team_ids: [],
    pending_team_id: null,
    alliances_formed: 1,
    alliances_target: 4,
    last_step: null,
    ...overrides,
  };
}

function picking(sel: FinalsSelection): FinalsBracket {
  return bracket({
    status: "selecting_alliances",
    alliances: [{ id: 1, seed: 1, team_ids: [1, 2], unavailable: false }],
    selection: sel,
  });
}

let current: FinalsBracket;
const writes: { path: string; options?: { method?: string; body?: unknown } }[] = [];

function show(finals: FinalsBracket, failWith?: ApiError) {
  current = finals;
  vi.mocked(apiRequest).mockImplementation(
    stubReads(
      () => [current],
      (path, options) => {
        writes.push({ path, options });
        if (failWith) throw failWith;
        return current;
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

describe("alliance selection panel", () => {
  it("says tablets follow along only when this is the active session", async () => {
    show(picking(selection()));
    renderFinals();
    expect(
      await screen.findByText(
        "Invite is disabled while an invite is open. Tablets follow along live only while this is the active session."
      )
    ).toBeInTheDocument();
  });

  it("shows formed alliances, the current captain and the invitable teams with ranks", async () => {
    show(picking(selection()));
    renderFinals();
    const rows = await screen.findAllByRole("row");
    const text = rows.map((row) => row.textContent);
    expect(text.some((cell) => cell?.includes("Team 1") && cell.includes("Team 2"))).toBe(true);
    const captainRow = screen.getByRole("row", { name: /Team 3/ });
    expect(captainRow).toHaveAttribute("aria-current", "true");
    const list = screen.getByRole("list", { name: "Can be invited" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getByText("Rank 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Finish with 1 alliances" })).not.toBeInTheDocument();
  });

  it("invites a team and disables Invite while an invite is open", async () => {
    show(picking(selection()));
    renderFinals();
    const item = (await screen.findAllByRole("listitem")).find((li) => li.textContent?.includes("Team 4"))!;
    fireEvent.click(within(item).getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(writes).toContainEqual(
        expect.objectContaining({
          path: "/api/finals/9/selection/invite",
          options: expect.objectContaining({ body: { team_id: 4 } }),
        })
      )
    );
  });

  it("with an open invite: waiting text, Invite disabled, Accept and Decline send the pending team", async () => {
    show(picking(selection({ pending_team_id: 4, invitable_team_ids: [5, 6, 7, 8] })));
    renderFinals();
    expect(await screen.findByText("invited, waiting…")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Invite" })) expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(writes).toContainEqual(
        expect.objectContaining({
          path: "/api/finals/9/selection/accept",
          options: expect.objectContaining({ body: { team_id: 4 } }),
        })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(writes.map((write) => write.path)).toContain("/api/finals/9/selection/decline")
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite" }));
    await waitFor(() => expect(writes.map((write) => write.path)).toContain("/api/finals/9/selection/cancel"));
  });

  it("shows declined teams struck through and the last step on Undo", async () => {
    show(
      picking(
        selection({
          declined_team_ids: [4],
          invitable_team_ids: [5, 6, 7, 8],
          last_step: { kind: "decline", captain_team_id: 3, team_id: 4 },
        })
      )
    );
    renderFinals();
    expect(await screen.findByText("last: 400 Team 4 declined 300 Team 3")).toBeInTheDocument();
    expect(screen.getByText("declined")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo last step" }));
    await waitFor(() => expect(writes.map((write) => write.path)).toContain("/api/finals/9/selection/undo"));
  });

  it("says who joined whom, and disables Undo with nothing to undo", async () => {
    show(picking(selection({ last_step: { kind: "accept", captain_team_id: 1, team_id: 2 } })));
    renderFinals();
    expect(await screen.findByText("last: 200 Team 2 joined 100 Team 1")).toBeInTheDocument();
  });

  it("disables Undo when there is no last step", async () => {
    show(picking(selection()));
    renderFinals();
    expect(await screen.findByRole("button", { name: "Undo last step" })).toBeDisabled();
  });

  it("offers Finish only when picking has run out of captains or invitable teams with two alliances", async () => {
    show(
      bracket({
        status: "selecting_alliances",
        alliances: [
          { id: 1, seed: 1, team_ids: [1, 2], unavailable: false },
          { id: 2, seed: 2, team_ids: [3, 4], unavailable: false },
        ],
        selection: selection({ captain_team_id: 5, invitable_team_ids: [], alliances_formed: 2 }),
      })
    );
    renderFinals();
    const finish = await screen.findByRole("button", { name: "Finish with 2 alliances" });
    fireEvent.click(finish);
    await waitFor(() => expect(writes.map((write) => write.path)).toContain("/api/finals/9/selection/finish"));
  });

  it("does not offer Finish with one alliance even when no teams are left", async () => {
    show(picking(selection({ captain_team_id: 3, invitable_team_ids: [], alliances_formed: 1 })));
    renderFinals();
    await screen.findByRole("button", { name: "Undo last step" });
    expect(screen.queryByRole("button", { name: /^Finish with/ })).not.toBeInTheDocument();
  });

  it("starts over after confirming", async () => {
    show(picking(selection()));
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

  it("shows the server's reason when a step is refused", async () => {
    show(picking(selection()), new ApiError(409, "An invite is already open."));
    renderFinals();
    const item = (await screen.findAllByRole("listitem")).find((li) => li.textContent?.includes("Team 4"))!;
    fireEvent.click(within(item).getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("An invite is already open.")).toBeInTheDocument();
  });
});
