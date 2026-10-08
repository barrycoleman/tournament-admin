import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n, type ScoresheetField } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AttemptsTable } from "../../src/skills/AttemptsTable";
import type { SessionSkillsType, SkillsAttemptRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

const TYPES: SessionSkillsType[] = [
  { key: "autonomous", label: "Autonomous", allowed: 3 },
  { key: "driver", label: "Driver", allowed: 3 },
];
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: null },
  { id: 2, number: "202", name: "Bravo", division_id: null },
];
const SCORE: ScoresheetField = {
  name: "score", label: "Score", data_type: "integer", widget: "counter",
  min: 0, max: 999, step: 1, options: null, icon: null, scope: "team", default: 0,
};

function attempt(id: number, team_id: number, skills_type: string, number: number, score: number): SkillsAttemptRead {
  return { id, team_id, skills_type, number, score, data: { score }, recorded_at: "", updated_at: "" };
}

const ATTEMPTS = [attempt(1, 1, "autonomous", 1, 20), attempt(2, 1, "driver", 1, 34), attempt(3, 2, "driver", 1, 30)];

function stub(onPut: (body: unknown) => unknown = () => attempt(1, 1, "autonomous", 1, 30)) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path.startsWith("/api/skills/types/")) return [SCORE] as never;
    if (path === "/api/skills/attempts/1" && opts?.method === "PUT") {
      const result = onPut(opts.body);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/skills/attempts/1" && opts?.method === "DELETE") return undefined as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderTable() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <AttemptsTable sessionId={1} types={TYPES} attempts={ATTEMPTS} teams={TEAMS} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const requests = (method: string) =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => (options as { method?: string })?.method === method);

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("AttemptsTable", () => {
  it("shows each team's attempts per type, padded, with the Overall", () => {
    stub();
    renderTable();
    const alpha = screen.getByRole("row", { name: /101/ });
    const cells = within(alpha).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("20 · — · —");
    expect(cells[2]).toHaveTextContent("34 · — · —");
    expect(cells[3]).toHaveTextContent("54");
  });

  it("filters rows as you type and says when nothing matches", () => {
    stub();
    renderTable();
    const filter = screen.getByLabelText("Find team");
    fireEvent.change(filter, { target: { value: "brav" } });
    expect(screen.queryByRole("row", { name: /101/ })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /202/ })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "zz" } });
    expect(screen.getByText("No teams match 'zz'")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("edits an attempt in a pre-filled dialog", async () => {
    stub();
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));
    const dialog = screen.getByRole("alertdialog", { name: "Autonomous attempt 1 · Team 101" });
    const score = await within(dialog).findByLabelText("Score");
    expect(score).toHaveValue("20");
    fireEvent.change(score, { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests("PUT")[0]).toEqual(["/api/skills/attempts/1", { method: "PUT", body: { data: { score: 30 } } }]);
  });

  it("shows an edit's field violations beside the field", async () => {
    stub(
      () =>
        new ApiError(422, "The scoresheet has errors.", {
          violations: [{ field: "score", message: "Must be at most 999." }],
        })
    );
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(await within(dialog).findByLabelText("Score"), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Must be at most 999.")).toBeInTheDocument();
  });

  it("shows an edit's unmapped violation in the dialog alert", async () => {
    stub(
      () =>
        new ApiError(422, "The scoresheet has errors.", {
          violations: [{ field: "mystery", message: "Something else is wrong." }],
        })
    );
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(await within(dialog).findByLabelText("Score"), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Something else is wrong.");
  });

  it("deletes an attempt after confirming, and Cancel sends nothing", async () => {
    stub();
    renderTable();
    const edit = () =>
      fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));

    edit();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    edit();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete attempt" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete this attempt?" });
    expect(within(confirm).getByText("Team 101 gets this Autonomous attempt back.")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete attempt" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests("DELETE")).toEqual([["/api/skills/attempts/1", { method: "DELETE" }]]);
    expect(requests("PUT")).toHaveLength(0);
  });
});
