import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DivisionsRoute } from "../../src/routes/DivisionsRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

let divisions: { id: number; event_id: number; name: string; target_team_count: number | null }[];
let teams: { id: number; division_id: number | null }[];

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  divisions = [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }];
  teams = [];
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: { name: string } } | undefined;
    if (path === "/api/divisions" && opts?.method === "POST") {
      const created = { id: divisions.length + 1, event_id: 1, name: opts.body!.name, target_team_count: null };
      divisions.push(created);
      return created as never;
    }
    if (path === "/api/divisions") return [...divisions] as never;
    if (path === "/api/teams") return teams as never;
    throw new Error(`unexpected request: ${opts?.method ?? "GET"} ${path}`);
  });
});

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <DivisionsRoute />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function addByEnter(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

describe("DivisionsRoute: adding divisions", () => {
  it("keeps the form open with the cursor in the name box through three adds", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Add a division..." }));
    const input = screen.getByLabelText("Division name");
    input.focus();
    for (const name of ["Red", "Blue", "Green"]) {
      addByEnter(input, name);
      expect(await screen.findByText(name)).toBeInTheDocument();
      expect(screen.getByLabelText("Division name")).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input).toHaveValue("");
    }
  });

  it("still asks about redistributing teams after an add when teams exist", async () => {
    teams = [{ id: 1, division_id: 1 }];
    renderRoute();
    await screen.findByText("Division 1");
    fireEvent.click(screen.getByRole("button", { name: "Add a division..." }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/teams"));
    addByEnter(screen.getByLabelText("Division name"), "Red");
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });
});
