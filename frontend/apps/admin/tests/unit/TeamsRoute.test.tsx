import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import type { TeamGridRow } from "../../src/teamCsv";
import enAdmin from "../../src/i18n/en/admin.json";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";
import { dismissTransientError, getTransientError } from "../../src/errorBanner";
import {
  TeamsRoute,
  dedupeByClientId,
  isBlankNewRow,
  mergeRows,
  mergeServerRows,
  reconcileUploadedRows,
} from "../../src/routes/TeamsRoute";

function row(overrides: Partial<TeamGridRow> & { clientId: string }): TeamGridRow {
  return {
    id: null,
    number: "",
    name: "",
    robot_name: "",
    organization: "",
    city: "",
    state: "",
    country: "",
    division: "",
    dirty: false,
    ...overrides,
  };
}

function serverTeam(id: number, number: string, name: string, divisionId: number | null) {
  return {
    id,
    number,
    name,
    robot_name: null,
    organization: null,
    city: null,
    state: null,
    country: null,
    division_id: divisionId,
  };
}

const DIVISIONS = [
  { id: 1, event_id: 1, name: "Red", target_team_count: null },
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <TeamsRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("isBlankNewRow", () => {
  it("is true only for a never-saved row with no text, whatever its division", () => {
    expect(isBlankNewRow(row({ clientId: "a", dirty: true }))).toBe(true);
    expect(isBlankNewRow(row({ clientId: "b", dirty: true, division: "Red" }))).toBe(true);
    expect(isBlankNewRow(row({ clientId: "c", dirty: true, name: "Alpha" }))).toBe(false);
    expect(isBlankNewRow(row({ clientId: "d", dirty: true, city: " x " }))).toBe(false);
    expect(isBlankNewRow(row({ clientId: "e", id: 4, dirty: true }))).toBe(false);
  });
});

describe("mergeRows", () => {
  it("replaces changed rows and keeps rows that are not in the filtered view", () => {
    const all = [
      row({ clientId: "server-1", division: "Red", name: "Alpha" }),
      row({ clientId: "server-2", division: "Blue", name: "Bravo" }),
      row({ clientId: "server-3", division: "Blue", name: "Charlie" }),
    ];
    // Only the Blue rows are visible; one of them was edited.
    const updatedVisible = [
      row({ clientId: "server-2", division: "Blue", name: "Bravo edited", dirty: true }),
      row({ clientId: "server-3", division: "Blue", name: "Charlie" }),
    ];

    const merged = mergeRows(all, updatedVisible);

    expect(merged.map((r) => r.clientId)).toEqual(["server-1", "server-2", "server-3"]);
    expect(merged[0].name).toBe("Alpha");
    expect(merged[1].name).toBe("Bravo edited");
    expect(merged[1].dirty).toBe(true);
  });

  it("appends brand-new rows that the grid produced", () => {
    const all = [row({ clientId: "server-1" })];
    const merged = mergeRows(all, [
      row({ clientId: "server-1" }),
      row({ clientId: "new-1", dirty: true }),
    ]);
    expect(merged.map((r) => r.clientId)).toEqual(["server-1", "new-1"]);
  });
});

describe("dedupeByClientId", () => {
  it("keeps the row carrying a server error over a clean duplicate", () => {
    const deduped = dedupeByClientId([
      row({ clientId: "server-5", name: "clean" }),
      row({ clientId: "server-5", name: "rejected", dirty: true, error: "Team number already in use" }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].name).toBe("rejected");
  });

  it("keeps an unsaved edit over a clean duplicate, in the first occurrence's position", () => {
    const deduped = dedupeByClientId([
      row({ clientId: "server-5", name: "clean" }),
      row({ clientId: "server-9", name: "other" }),
      row({ clientId: "server-5", name: "edited", dirty: true }),
    ]);
    expect(deduped.map((r) => [r.clientId, r.name])).toEqual([
      ["server-5", "edited"],
      ["server-9", "other"],
    ]);
  });

  it("leaves a roster with no collisions untouched", () => {
    const rows = [row({ clientId: "server-1" }), row({ clientId: "new-1", dirty: true })];
    expect(dedupeByClientId(rows)).toEqual(rows);
  });
});

describe("mergeServerRows", () => {
  it("keeps locally dirty rows when the server list is refetched", () => {
    const previous = [
      row({ clientId: "server-1", name: "stale local copy" }),
      row({ clientId: "server-2", name: "edited", dirty: true }),
      row({ clientId: "new-1", name: "rejected", dirty: true, error: "Unknown division" }),
    ];
    const serverRows = [
      row({ clientId: "server-1", name: "fresh from server" }),
      row({ clientId: "server-2", name: "server value" }),
    ];

    const merged = mergeServerRows(previous, serverRows);

    expect(merged.map((r) => r.clientId)).toEqual(["server-1", "server-2", "new-1"]);
    expect(merged[0].name).toBe("fresh from server");
    expect(merged[1].name).toBe("edited");
    expect(merged[2].error).toBe("Unknown division");
  });

  it("drops clean local rows the server no longer has and appends new server rows", () => {
    const merged = mergeServerRows(
      [row({ clientId: "server-1" }), row({ clientId: "server-9" })],
      [row({ clientId: "server-1" }), row({ clientId: "server-4" })]
    );
    expect(merged.map((r) => r.clientId)).toEqual(["server-1", "server-4"]);
  });
});

describe("reconcileUploadedRows", () => {
  it("appends an uploaded row whose number has no existing match", () => {
    const existing = [row({ clientId: "server-1", number: "101", name: "Alpha" })];
    const uploaded = [row({ clientId: "new-1", number: "202", name: "Bravo", dirty: true })];

    const result = reconcileUploadedRows(existing, uploaded);

    expect(result.map((r) => r.clientId)).toEqual(["server-1", "new-1"]);
    expect(result[0].dirty).toBe(false);
  });

  it("leaves the existing row completely untouched when the uploaded data is identical", () => {
    const existing = [row({ clientId: "server-1", number: "101", name: "Alpha", division: "Red" })];
    const uploaded = [
      row({ clientId: "new-1", number: "101", name: "Alpha", division: "Red", dirty: true }),
    ];

    const result = reconcileUploadedRows(existing, uploaded);

    expect(result).toEqual(existing);
    expect(result[0].dirty).toBe(false);
  });

  it("merges uploaded fields onto the matching row and marks it dirty when data differs", () => {
    const existing = [
      row({ clientId: "server-1", id: 1, number: "101", name: "Alpha", city: "Springfield" }),
    ];
    const uploaded = [
      row({ clientId: "new-1", number: "101", name: "Alpha Renamed", city: "Springfield", dirty: true }),
    ];

    const result = reconcileUploadedRows(existing, uploaded);

    expect(result).toHaveLength(1);
    expect(result[0].clientId).toBe("server-1");
    expect(result[0].id).toBe(1);
    expect(result[0].name).toBe("Alpha Renamed");
    expect(result[0].dirty).toBe(true);
  });

  it("matches numbers after trimming whitespace", () => {
    const existing = [row({ clientId: "server-1", number: "101 ", name: "Alpha" })];
    const uploaded = [row({ clientId: "new-1", number: " 101", name: "Alpha Two", dirty: true })];

    const result = reconcileUploadedRows(existing, uploaded);

    expect(result).toHaveLength(1);
    expect(result[0].clientId).toBe("server-1");
    expect(result[0].name).toBe("Alpha Two");
  });

  it("clears a matched row's stale server error when the re-upload changes its data", () => {
    const existing = [
      row({
        clientId: "server-1",
        number: "101",
        name: "Alpha",
        dirty: true,
        error: "Team number already in use",
      }),
    ];
    const uploaded = [row({ clientId: "new-1", number: "101", name: "Alpha Two", dirty: true })];

    const result = reconcileUploadedRows(existing, uploaded);

    expect(result[0].error).toBeUndefined();
  });
});

describe("TeamsRoute", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    dismissTransientError();
  });

  /** Types into a cell of the last row (Name by default) and commits it. */
  async function typeIntoLastRow(value: string, column = 1) {
    const rows = screen.getAllByRole("row");
    fireEvent.doubleClick(within(rows[rows.length - 1]).getAllByRole("gridcell")[column]);
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value } });
    fireEvent.blur(editor);
    await screen.findByText(value);
  }

  function stubReads(divisions: typeof DIVISIONS, teams: ReturnType<typeof serverTeam>[]) {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/divisions") return divisions as never;
      if (path === "/api/teams") return teams as never;
      throw new Error(`unexpected request: ${path}`);
    });
  }

  it("hides the division column and filter entirely when there is only one division", async () => {
    stubReads([DIVISIONS[0]], [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    expect(screen.queryByRole("columnheader", { name: "Division" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Division")).not.toBeInTheDocument();
  });

  it("re-uploading a CSV with a blank Division column does not mark an already-assigned team dirty in a single-division event", async () => {
    // Regression test: server/CLAUDE.md's assign_sole_division means an
    // existing team's division_id is already the sole division once
    // saved, so toGridRow resolves it to that division's name -- but a
    // CSV whose Division column is blank parses to "". Without
    // normalizing that blank to the sole division's name before
    // reconciling, this byte-for-byte mismatch would falsely flag the
    // row as changed on every re-upload of an otherwise-unmodified file.
    stubReads([DIVISIONS[0]], [serverTeam(1, "9201A", "Reupload Team", 1)]);
    renderRoute();

    await screen.findByText("Reupload Team");

    const csvContent =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      "9201A,Reupload Team,,,,,,\n";
    const file = new File([csvContent], "teams.csv", { type: "text/csv" });
    const input = document.getElementById("csv-upload") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.queryByText("unsaved")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("shows the division column and filter when there is more than one division", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    expect(screen.getByRole("columnheader", { name: "Division" })).toBeInTheDocument();
    expect(screen.getByLabelText("Division")).toBeInTheDocument();
  });

  it("filters the grid to the selected division without losing the other rows", async () => {
    stubReads(DIVISIONS, [
      serverTeam(1, "101", "Alpha", 1),
      serverTeam(2, "202", "Bravo", 2),
    ]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "Blue" } });
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "" } });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("marks a row dirty when a text cell is edited and saves only the dirty rows", async () => {
    stubReads(DIVISIONS, [
      serverTeam(1, "101", "Alpha", 1),
      serverTeam(2, "202", "Bravo", 2),
    ]);
    renderRoute();

    const cell = await screen.findByText("Bravo");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.doubleClick(cell);
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "Bravo Two" } });
    fireEvent.blur(editor);

    await screen.findByText("Bravo Two");
    expect(screen.getByText("unsaved")).toBeInTheDocument();

    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams")
        return [serverTeam(1, "101", "Alpha", 1), serverTeam(2, "202", "Bravo Two", 2)] as never;
      if (path === "/api/teams/bulk") {
        const body = (options as { body: { rows: unknown[] } }).body;
        expect(body.rows).toHaveLength(1);
        expect(body.rows[0]).toMatchObject({ number: "202", name: "Bravo Two", division: "Blue" });
        return {
          results: [
            { row_index: 0, status: "updated", team: serverTeam(2, "202", "Bravo Two", 2), error: null },
          ],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("1 saved");
    await waitFor(() => expect(screen.queryByText("unsaved")).not.toBeInTheDocument());
  });

  it("sends the team id when an existing team's number is edited, so it updates in place", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    fireEvent.doubleClick(await screen.findByText("101"));
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "101F" } });
    fireEvent.blur(editor);
    await screen.findByText("101F");

    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101F", "Alpha", 1)] as never;
      if (path === "/api/teams/bulk") {
        const body = (options as { body: { rows: unknown[] } }).body;
        expect(body.rows[0]).toMatchObject({ id: 1, number: "101F", name: "Alpha" });
        return {
          results: [
            { row_index: 0, status: "updated", team: serverTeam(1, "101F", "Alpha", 1), error: null },
          ],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 saved");
  });

  it("adds a blank row, pre-filled with the active division filter", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "Blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));

    // A row with nothing typed in it isn't an unsaved change yet.
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    // Some text but no number: it is sent, and the server says what's missing.
    await typeIntoLastRow("Half Typed");
    expect(screen.getByText("unsaved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101", "Alpha", 1)] as never;
      if (path === "/api/teams/bulk") {
        const body = (options as { body: { rows: { division: string | null }[] } }).body;
        expect(body.rows).toHaveLength(1);
        expect(body.rows[0].division).toBe("Blue");
        return {
          results: [
            { row_index: 0, status: "error", team: null, error: "number and name are required" },
          ],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("0 saved, 1 need fixing");
    // The rejected row survives the post-save refetch with its error attached.
    expect(await screen.findByText("number and name are required")).toBeInTheDocument();
  });

  it("shows a hint when there are no teams yet, and drops it once a row exists", async () => {
    stubReads(DIVISIONS, []);
    renderRoute();
    expect(
      await screen.findByText("No teams yet. Add a row, then type or paste rows from a spreadsheet into it, or upload a CSV.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(screen.queryByText(/No teams yet/)).not.toBeInTheDocument();
  });

  it("shows no empty hint when teams exist", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();
    await screen.findByText("Alpha");
    expect(screen.queryByText(/No teams yet/)).not.toBeInTheDocument();
  });

  it("commits Enter in the last row and starts a new row at its Number cell", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1), serverTeam(2, "202", "Bravo", 2)]);
    renderRoute();

    fireEvent.doubleClick(await screen.findByText("Bravo"));
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "Bravo Two" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(await screen.findByText("Bravo Two")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("row").slice(1)).toHaveLength(3));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(screen.getAllByRole("row")[3]).getAllByRole("gridcell")[0])
    );
    // The new row is blank, so only the edited one is unsaved.
    expect(screen.getAllByText("unsaved")).toHaveLength(1);
  });

  it("saves after Enter on the last row without sending the blank row it added", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    fireEvent.click(await screen.findByRole("button", { name: "Add row" }));
    await typeIntoLastRow("303", 0);
    const rows = screen.getAllByRole("row");
    fireEvent.doubleClick(within(rows[rows.length - 1]).getAllByRole("gridcell")[1]);
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "Charlie" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("row").slice(1)).toHaveLength(3));

    let sent: unknown[] = [];
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101", "Alpha", 1), serverTeam(3, "303", "Charlie", null)] as never;
      if (path === "/api/teams/bulk") {
        sent = (options as { body: { rows: unknown[] } }).body.rows;
        return {
          results: [{ row_index: 0, status: "created", team: serverTeam(3, "303", "Charlie", null), error: null }],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("1 saved");
    expect(screen.getByRole("status")).not.toHaveTextContent("need fixing");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ number: "303", name: "Charlie" });
    // The blank row is gone and nothing is left unsaved.
    await waitFor(() => expect(screen.getAllByRole("row").slice(1)).toHaveLength(2));
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("doesn't add a row when Enter confirms an IME composition", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    fireEvent.doubleClick(await screen.findByText("Alpha"));
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "阿尔法" } });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
  });

  it("keeps Enter in an earlier row to committing the edit, with no new row", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1), serverTeam(2, "202", "Bravo", 2)]);
    renderRoute();

    fireEvent.doubleClick(await screen.findByText("Alpha"));
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "Alpha Two" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(await screen.findByText("Alpha Two")).toBeInTheDocument();
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
  });

  it("keeps the Number column narrow and gives the slack to Name", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1), serverTeam(2, "202", "Bravo", 2)]);
    renderRoute();
    await screen.findByText("Alpha");
    const grid = screen.getByRole("grid");
    const widths = await waitFor(() => {
      const template = grid.style.gridTemplateColumns;
      const parsed = template.split(" ").map((w) => parseFloat(w));
      expect(parsed.every((w) => w > 0)).toBe(true);
      return parsed;
    });
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    const number = widths[headers.indexOf("Number")];
    const name = widths[headers.indexOf("Name")];
    expect(number).toBeGreaterThanOrEqual(90);
    expect(number).toBeLessThanOrEqual(110);
    expect(name).toBe(Math.max(...widths));
    expect(name).toBeGreaterThan(widths.reduce((a, b) => a + b, 0) / 3);
  });

  it("moves focus into the first cell of a newly added row", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);
      expect(rows[1].contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).toBe(within(screen.getAllByRole("row")[2]).getAllByRole("gridcell")[0]);
  });

  describe("after a save", () => {
    function stubSave(sessions: unknown[], activeSessionId: number | null) {
      vi.mocked(apiRequest).mockImplementation(async (path: string) => {
        if (path === "/api/divisions") return DIVISIONS as never;
        if (path === "/api/teams") return [serverTeam(1, "101", "Alpha", 1)] as never;
        if (path === "/api/sessions") return sessions as never;
        if (path === "/api/event") return { id: 1, name: "E", active_session_id: activeSessionId } as never;
        if (path.startsWith("/api/sessions/") && path.endsWith("/playing-windows")) return [] as never;
        if (path === "/api/teams/bulk") {
          return {
            results: [{ row_index: 0, status: "created", team: serverTeam(2, "202", "Bravo", 1), error: null }],
          } as never;
        }
        throw new Error(`unexpected request: ${path}`);
      });
    }

    async function addAndSave() {
      renderRoute();
      await screen.findByText("Alpha");
      fireEvent.click(screen.getByRole("button", { name: "Add row" }));
      const cells = within(screen.getAllByRole("row")[2]).getAllByRole("gridcell");
      fireEvent.doubleClick(cells[0]);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "202" } });
      fireEvent.blur(screen.getByRole("textbox"));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("status");
    }

    it("offers to create a session when there are none", async () => {
      stubSave([], null);
      await addAndSave();
      const link = await screen.findByRole("link", { name: "create a session" });
      expect(link).toHaveAttribute("href", "/sessions/new");
    });

    it("offers to go to the session the admin would land on when sessions exist", async () => {
      const session = (id: number, label: string) => ({
        id, event_id: 1, label, session_date: null, timezone: null, has_scored_matches: false,
        qualification_finalized_at: null, qualification_drops: null,
      });
      stubSave([session(7, "Saturday"), session(8, "Sunday")], 8);
      await addAndSave();
      const link = await screen.findByRole("link", { name: "go to Sunday" });
      expect(link).toHaveAttribute("href", "/sessions/8/today");
    });
  });

  it("leaves no duplicate row when a new row's number turns out to belong to an existing team", async () => {
    // /api/teams/bulk upserts by NUMBER, so a brand-new local row typed
    // with an already-taken number comes back as an UPDATE to that team.
    // Its clientId then becomes `server-1` -- which the original row
    // already holds. Both must not survive: they'd share a React key and
    // editing either would rewrite both.
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));

    const dataRows = () => screen.getAllByRole("row").slice(1);
    expect(dataRows()).toHaveLength(2);

    const blankRow = dataRows()[1];
    const cells = within(blankRow).getAllByRole("gridcell");
    const typeInto = (cell: HTMLElement, value: string) => {
      fireEvent.doubleClick(cell);
      const editor = screen.getByRole("textbox");
      fireEvent.change(editor, { target: { value } });
      fireEvent.blur(editor);
    };
    typeInto(cells[0], "101");
    typeInto(within(dataRows()[1]).getAllByRole("gridcell")[1], "Alpha Renamed");

    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101", "Alpha Renamed", 1)] as never;
      if (path === "/api/teams/bulk") {
        const body = (options as { body: { rows: { number: string }[] } }).body;
        expect(body.rows).toHaveLength(1);
        expect(body.rows[0].number).toBe("101");
        return {
          results: [
            {
              row_index: 0,
              status: "updated",
              team: serverTeam(1, "101", "Alpha Renamed", 1),
              error: null,
            },
          ],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 saved");

    // The two rows collapsed back into one, and the refetch reconciled its
    // fields against the server.
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    expect(screen.getAllByText("Alpha Renamed")).toHaveLength(1);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
  });

  it("keeps every row dirty and shows no summary when the bulk request itself fails", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await typeIntoLastRow("Charlie");

    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101", "Alpha", 1)] as never;
      throw new ApiError(500, "boom");
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // An ApiError is a domain failure the server described, so it shows
    // inline next to Save (like every other mutation on this screen)
    // rather than in the shell's background-query banner.
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(getTransientError()).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("unsaved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("clears a rejected row's error as soon as the row is edited again", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await typeIntoLastRow("Charlie");

    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101", "Alpha", 1)] as never;
      if (path === "/api/teams/bulk") {
        return {
          results: [
            { row_index: 0, status: "error", team: null, error: "number and name are required" },
          ],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("number and name are required")).toBeInTheDocument();
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();

    // Fix the row the server rejected: its stale error must disappear and
    // the plain "unsaved" indicator must come back.
    const rejectedRow = screen.getAllByRole("row").slice(1)[1];
    const numberCell = within(rejectedRow).getAllByRole("gridcell")[0];
    fireEvent.doubleClick(numberCell);
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "303" } });
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(screen.queryByText("number and name are required")).not.toBeInTheDocument()
    );
    expect(screen.getByText("unsaved")).toBeInTheDocument();
  });

  it("discards a never-saved row locally, with no DELETE request", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    const dataRows = () => screen.getAllByRole("row").slice(1);
    const baseline = dataRows().length;

    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(dataRows()).toHaveLength(baseline + 1);

    const addedRow = dataRows()[baseline];
    fireEvent.click(within(addedRow).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(dataRows()).toHaveLength(baseline));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const deleteCalls = vi
      .mocked(apiRequest)
      .mock.calls.filter(
        ([, options]) => (options as { method?: string } | undefined)?.method === "DELETE"
      );
    expect(deleteCalls).toEqual([]);
  });

  it("ignores a second Save click while the first request is still in flight", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await typeIntoLastRow("New");

    let releaseBulk: (() => void) | null = null;
    const bulkInFlight = new Promise<void>((resolve) => {
      releaseBulk = resolve;
    });
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/divisions") return DIVISIONS as never;
      if (path === "/api/teams") return [serverTeam(1, "101", "Alpha", 1)] as never;
      if (path === "/api/teams/bulk") {
        await bulkInFlight;
        return {
          results: [
            { row_index: 0, status: "created", team: serverTeam(2, "303", "New", null), error: null },
          ],
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    // Both clicks land inside one act() block, so React has not re-rendered
    // (and so not disabled the button) between them -- this is the genuine
    // double-submit race, not one a disabled attribute would have caught.
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    act(() => {
      saveButton.click();
      saveButton.click();
    });

    const bulkCalls = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/teams/bulk");
    expect(bulkCalls()).toHaveLength(1);

    releaseBulk!();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(bulkCalls()).toHaveLength(1);
  });

  it("reassigns a row's division through the division cell editor", async () => {
    stubReads(DIVISIONS, [
      serverTeam(1, "101", "Alpha", 1),
      serverTeam(2, "202", "Bravo", 2),
    ]);
    renderRoute();

    // Filter to Red so the edit has to be merged back into a roster that
    // still holds the (hidden) Blue row.
    await screen.findByText("Alpha");
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "Red" } });
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument();

    const divisionCell = screen.getAllByRole("gridcell").find((cell) => cell.textContent === "Red");
    expect(divisionCell).toBeDefined();
    fireEvent.doubleClick(divisionCell!);

    const editor = screen
      .getAllByRole("combobox")
      .find((element) => element.id !== "division-filter");
    expect(editor).toBeDefined();
    fireEvent.change(editor!, { target: { value: "Blue" } });

    // The edited row left the Red filter, and the untouched Blue row is
    // still in `allRows` -- clearing the filter shows both.
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "" } });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText("unsaved")).toBeInTheDocument();
  });
});
