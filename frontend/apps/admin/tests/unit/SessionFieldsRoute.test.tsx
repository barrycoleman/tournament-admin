import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionFieldsRoute } from "../../src/routes/SessionFieldsRoute";
import type { Division, FieldRead, FieldSetRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
};
const ONE_DIVISION: Division[] = [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }];
const TWO_DIVISIONS: Division[] = [
  ...ONE_DIVISION,
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];
const MAIN_SET: FieldSetRead = { id: 10, session_id: 1, name: "Main Fields", division_id: null };
const FIELD_A: FieldRead = { id: 100, field_set_id: 10, name: "Field A" };

const NOT_HANDLED = Symbol("not handled");
type Override = (path: string, options?: { method?: string; body?: unknown }) => unknown;

function stubServer(
  state: { divisions: Division[]; fieldSets: FieldSetRead[]; fields: FieldRead[] },
  override: Override = () => NOT_HANDLED
) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    const handled = override(path, opts);
    if (handled instanceof Error) throw handled;
    if (handled !== NOT_HANDLED) return handled as never;
    if (path === "/api/divisions") return state.divisions as never;
    if (path === "/api/field-sets?session_id=1") return state.fieldSets as never;
    if (path === "/api/fields?session_id=1") return state.fields as never;
    throw new Error(`unexpected request: ${opts?.method ?? "GET"} ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderFields() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionFieldsRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("SessionFieldsRoute", () => {
  it("renders a card per field set and hides the division control for a single division", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] });
    renderFields();

    const card = await screen.findByRole("region", { name: "Main Fields" });
    expect(within(card).getByText("Field A")).toBeInTheDocument();
    expect(screen.queryByLabelText("Division")).not.toBeInTheDocument();
  });

  it("creates the first field without a field_set_id when the session has none", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [], fields: [] }, (path, options) =>
      path === "/api/fields" && options?.method === "POST" ? FIELD_A : NOT_HANDLED
    );
    renderFields();

    fireEvent.change(await screen.findByLabelText("Add your first field"), {
      target: { value: " Field A " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields", {
        method: "POST",
        body: { session_id: 1, name: "Field A" },
      })
    );
  });

  it("adds a field to a specific set with an explicit field_set_id", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/fields" && options?.method === "POST"
        ? { id: 101, field_set_id: 10, name: "Field B" }
        : NOT_HANDLED
    );
    renderFields();

    fireEvent.change(await screen.findByLabelText("New field name for Main Fields"), {
      target: { value: "Field B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields", {
        method: "POST",
        body: { session_id: 1, name: "Field B", field_set_id: 10 },
      })
    );
  });

  it("shows the division select for several divisions, notes unassigned sets, and assigns one", async () => {
    stubServer({ divisions: TWO_DIVISIONS, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/field-sets/10" && options?.method === "PATCH"
        ? { ...MAIN_SET, division_id: 2 }
        : NOT_HANDLED
    );
    renderFields();

    expect(
      await screen.findByText("Not used for scheduling until assigned to a division.")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "2" } });

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10", {
        method: "PATCH",
        body: { division_id: 2 },
      })
    );
  });

  it("shows a refused delete inline on that field's card", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/fields/100" && options?.method === "DELETE"
        ? new ApiError(409, "Field has scheduled matches; clear the schedule first")
        : NOT_HANDLED
    );
    renderFields();

    fireEvent.click(await screen.findByRole("button", { name: "Remove field Field A" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const card = screen.getByRole("region", { name: "Main Fields" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Field has scheduled matches; clear the schedule first"
    );
  });
});
