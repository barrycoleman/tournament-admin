import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
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
        <TeamsRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

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

  it("adds a blank row, pre-filled with the active division filter", async () => {
    stubReads(DIVISIONS, [serverTeam(1, "101", "Alpha", 1)]);
    renderRoute();

    await screen.findByText("Alpha");
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "Blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));

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
