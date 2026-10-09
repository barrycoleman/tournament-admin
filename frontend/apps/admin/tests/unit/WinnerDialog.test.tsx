import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { WinnerDialog } from "../../src/awards/WinnerDialog";
import type { AwardRead, AwardSlotRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SLOT: AwardSlotRead = {
  division_id: 7, division_name: "Rookie", status: "judged_pending", winners: [],
  override_reason: null, note: null, moved_team_ids: [],
};
const DESIGN: AwardRead = {
  id: 31, session_id: 5, position: 0, name: "Design Award", description: null, kind: "judged",
  scope: "division", division_ids: [], source: null, skills_type: null, basis: null, placement: null, slots: [SLOT],
};

function stub() {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === "/api/teams") {
      return [
        { id: 1, number: "101", name: "Alpha", division_id: 7 },
        { id: 2, number: "202", name: "Bravo", division_id: 7 },
        { id: 3, number: "303", name: "Charlie", division_id: 8 },
        { id: 4, number: "404", name: "Delta", division_id: 7 },
      ] as never;
    }
    if (path === "/api/sessions/5/participants") {
      return [{ team_id: 1, checked_in: true }, { team_id: 2, checked_in: false }, { team_id: 3, checked_in: true }] as never;
    }
    if (path === "/api/sessions/5/awards/team-history") {
      return [
        { team_id: 2, awards: [{ award_id: 30, award_name: "Think", kind: "judged", session_id: 5, session_label: "Saturday" }] },
      ] as never;
    }
    if (options?.method) return {} as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderDialog(mode: "judged" | "override" = "judged", award: AwardRead = DESIGN) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <WinnerDialog sessionId={5} award={award} slot={award.slots[0]} mode={mode} onClose={onClose} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  return onClose;
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  stub();
});

describe("WinnerDialog", () => {
  it("lists only the session's teams in the slot's division, with history warnings", async () => {
    renderDialog();
    const list = await screen.findByRole("radiogroup", { name: "Teams" });
    await screen.findByRole("radio", { name: /101 Alpha/ });
    await screen.findByText("Already won a judged award this session");
    const labels = within(list).getAllByRole("radio").map((r) => r.closest("label")!.textContent);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain("101 Alpha");
    expect(labels[1]).toContain("202 Bravo");
    expect(labels[1]).toContain("Already won a judged award this session");
  });

  it("filters by number or name", async () => {
    renderDialog();
    await screen.findByRole("radiogroup", { name: "Teams" });
    fireEvent.change(screen.getByLabelText("Find a team"), { target: { value: "brav" } });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("saves the chosen judged winner", async () => {
    const onClose = renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: /101 Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/awards/31/slots/7", { method: "PUT", body: { team_id: 1 } })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("requires teams and a reason for an override", async () => {
    const champion: AwardRead = { ...DESIGN, id: 40, kind: "performance", source: "finals", basis: "session", placement: 1 };
    renderDialog("override", champion);
    const box = await screen.findByRole("checkbox", { name: /101 Alpha/ });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose at least one team.")).toBeInTheDocument();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("checkbox", { name: /202 Bravo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a reason.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for the override"), { target: { value: "Inspection" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/awards/40/slots/7", {
        method: "PUT",
        body: { team_ids: [1, 2], reason: "Inspection" },
      })
    );
  });

  it("never sends a current winner the list doesn't show", async () => {
    // A season-basis award can resolve to a team not entered this session (Delta).
    const slot: AwardSlotRead = {
      ...SLOT,
      status: "resolved",
      winners: [
        { team_id: 1, number: "101", name: "Alpha", organization: null },
        { team_id: 4, number: "404", name: "Delta", organization: null },
      ],
    };
    const season: AwardRead = {
      ...DESIGN, id: 41, kind: "performance", source: "teamwork_ranking", basis: "season", placement: 1, slots: [slot],
    };
    renderDialog("override", season);
    expect(await screen.findByRole("checkbox", { name: /101 Alpha/ })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /404 Delta/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for the override"), { target: { value: "Withdrew" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/awards/41/slots/7", {
        method: "PUT",
        body: { team_ids: [1], reason: "Withdrew" },
      })
    );
  });

  it("shows the server's message when the session is finalized", async () => {
    const base = vi.mocked(apiRequest).getMockImplementation()!;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "PUT") throw new ApiError(409, "Unfinalize awards to make changes.");
      return base(path, options as never);
    });
    renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: /101 Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unfinalize awards to make changes.");
  });
});
