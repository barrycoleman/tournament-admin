import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionsRoute } from "../../src/routes/SessionsRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SessionsRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SessionsRoute", () => {
  it("lists existing sessions", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: "2026-09-05", timezone: "America/Los_Angeles" },
        ] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByText("Saturday")).toBeInTheDocument();
    expect(screen.getByText("2026-09-05")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
  });

  it("marks only the event's active session with a badge", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null },
          { id: 2, event_id: 1, label: "Sunday", session_date: null, timezone: null },
        ] as never;
      }
      if (path === "/api/event") return { id: 1, name: "Event", active_session_id: 2 } as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const badge = await screen.findByText("Active session");
    expect(badge.closest("tr")).toHaveTextContent("Sunday");
    expect(screen.getAllByText("Active session")).toHaveLength(1);
  });

  it("shows an empty-state message when there are no sessions", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByText(/No sessions yet/)).toBeInTheDocument();
  });

  it("creates a new session", async () => {
    let createBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) return [] as never;
      if (path === "/api/sessions" && (options as { method?: string })?.method === "POST") {
        createBody = (options as { body: unknown }).body;
        return { id: 2, event_id: 1, label: "Sunday", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByRole("button", { name: "Add session..." });
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Sunday" } });
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    await waitFor(() =>
      expect(createBody).toEqual({ label: "Sunday", session_date: null, timezone: null })
    );
  });

  it("edits an existing session", async () => {
    let patchBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null },
        ] as never;
      }
      if (path === "/api/sessions/1" && (options as { method?: string })?.method === "PATCH") {
        patchBody = (options as { body: unknown }).body;
        return { id: 1, event_id: 1, label: "Renamed", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchBody).toEqual({ label: "Renamed", session_date: null, timezone: null })
    );
  });

  it("opening the create form while a row is being edited closes the edit form", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null },
        ] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByDisplayValue("Saturday")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));

    expect(screen.queryByDisplayValue("Saturday")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add session" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Session name")).toHaveLength(1);
  });

  it("opening a row's edit form while creating closes the create form", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null },
        ] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    expect(screen.getByRole("button", { name: "Add session" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Saturday")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Session name")).toHaveLength(1);
  });

  it("shows an inline error on a failed create", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) return [] as never;
      if (path === "/api/sessions" && (options as { method?: string })?.method === "POST") {
        throw new ApiError(422, "Label cannot be empty");
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByRole("button", { name: "Add session..." });
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Label cannot be empty");
  });

  describe("row actions", () => {
    const SATURDAY = {
      id: 1,
      event_id: 1,
      label: "Saturday",
      session_date: null,
      timezone: null,
      has_scored_matches: false,
    };
    const SUNDAY = { ...SATURDAY, id: 2, label: "Sunday" };

    function stub(
      sessions: (typeof SATURDAY)[],
      activeId: number | null,
      onWrite: (path: string, options: { method?: string; body?: unknown }) => unknown = () => null
    ) {
      vi.mocked(apiRequest).mockReset();
      vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
        const opts = options as { method?: string; body?: unknown } | undefined;
        if (opts?.method) {
          const result = onWrite(path, opts);
          if (result instanceof Error) throw result;
          return result as never;
        }
        if (path === "/api/sessions") return sessions as never;
        if (path === "/api/event") return { id: 1, name: "Event", active_session_id: activeId } as never;
        throw new Error(`unexpected request: ${path}`);
      });
    }

    it("sets another session active, and offers no Set active on the active one", async () => {
      let activated: unknown = null;
      stub([SATURDAY, SUNDAY], 2, (path, options) => {
        if (path === "/api/event/active-session") activated = options.body;
        return { id: 1, name: "Event", active_session_id: 1 };
      });
      renderRoute();

      const button = await screen.findByRole("button", { name: "Set Saturday as the active session" });
      expect(
        screen.queryByRole("button", { name: "Set Sunday as the active session" })
      ).not.toBeInTheDocument();
      fireEvent.click(button);

      await waitFor(() => expect(activated).toEqual({ session_id: 1 }));
    });

    it("deletes a session only after its name is typed", async () => {
      let deleted: string | null = null;
      stub([SATURDAY, SUNDAY], null, (path, options) => {
        if (options.method === "DELETE") deleted = path;
        return undefined;
      });
      renderRoute();

      fireEvent.click(await screen.findByRole("button", { name: "Delete session Saturday" }));
      const dialog = await screen.findByRole("alertdialog");
      const confirm = within(dialog).getByRole("button", { name: "Delete session" });
      expect(confirm).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText('Type "Saturday" to confirm'), {
        target: { value: "Saturday" },
      });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);

      await waitFor(() => expect(deleted).toBe("/api/sessions/1"));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("warns that deleting the active session leaves none active", async () => {
      stub([SATURDAY], 1);
      renderRoute();

      fireEvent.click(await screen.findByRole("button", { name: "Delete session Saturday" }));

      expect(await screen.findByRole("alertdialog")).toHaveTextContent(
        "It's the active session, so no session will be active afterwards."
      );
    });

    it("disables Delete for a session with scored matches and says why", async () => {
      stub([{ ...SATURDAY, has_scored_matches: true }], null);
      renderRoute();

      const button = await screen.findByRole("button", { name: "Delete session Saturday" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute(
        "title",
        "This session has scored matches, so it can't be deleted."
      );
    });

    it("keeps the dialog open with the server's message when the delete is refused", async () => {
      stub([SATURDAY], null, () => new ApiError(409, "This session has scored matches, so it can't be deleted."));
      renderRoute();

      fireEvent.click(await screen.findByRole("button", { name: "Delete session Saturday" }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.change(within(dialog).getByLabelText('Type "Saturday" to confirm'), {
        target: { value: "Saturday" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete session" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "This session has scored matches"
      );
    });
  });
});
