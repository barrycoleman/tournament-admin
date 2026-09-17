import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import {
  PickerRoute,
  generateDefaultFilename,
  sanitizeFilename,
  withDbExtension,
} from "../../src/routes/PickerRoute";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PickerRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

/** Builds a fetch mock keyed on method+path, matching how apiRequest
 * (packages/shared/src/api-client.ts) actually calls the global fetch:
 * a bare `fetch(path, { method, headers, body })`, so mocking at the
 * fetch boundary (like AuthenticatedLayout.test.tsx) exercises the real
 * apiRequest/ApiError parsing instead of stubbing it away. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("sanitizeFilename", () => {
  it("converts whitespace to underscores", () => {
    expect(sanitizeFilename("my tournament.db")).toBe("my_tournament.db");
    expect(sanitizeFilename("a  b\tc")).toBe("a_b_c");
  });

  it("drops characters that are not letters, numbers, underscore, hyphen, or a period", () => {
    expect(sanitizeFilename("regional!.db")).toBe("regional.db");
    expect(sanitizeFilename("a/b\\c:d.db")).toBe("abcd.db");
  });

  it("leaves an already-valid filename untouched", () => {
    expect(sanitizeFilename("20260916T1454-Regional_2.db")).toBe("20260916T1454-Regional_2.db");
  });
});

describe("withDbExtension", () => {
  it("appends .db when missing", () => {
    expect(withDbExtension("regional")).toBe("regional.db");
  });

  it("leaves a name that already ends in .db unchanged", () => {
    expect(withDbExtension("regional.db")).toBe("regional.db");
  });
});

describe("generateDefaultFilename", () => {
  it("formats a local-time timestamp as YYYYMMDDTHHMM-tournament.db", () => {
    expect(generateDefaultFilename(new Date(2026, 8, 16, 14, 54))).toBe(
      "20260916T1454-tournament.db"
    );
  });

  it("zero-pads single-digit month, day, hour, and minute", () => {
    expect(generateDefaultFilename(new Date(2026, 0, 5, 3, 7))).toBe(
      "20260105T0307-tournament.db"
    );
  });
});

describe("PickerRoute", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the menu screen with both action buttons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ allowed_directories: [] }))
    );
    renderRoute();

    expect(screen.getByRole("button", { name: "Create New Tournament" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Existing Tournament" })).toBeInTheDocument();
  });

  it("creates a tournament from the create screen and starts the restart poll", async () => {
    let createCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/picker/directories" && method === "GET") {
          return jsonResponse({ allowed_directories: ["/tournaments"] });
        }
        if (url === "/api/picker/create" && method === "POST") {
          createCalled = true;
          expect(JSON.parse(init!.body as string)).toEqual({
            directory: "/tournaments",
            filename: "regional.db",
          });
          return jsonResponse({ status: "restarting" }, 202);
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));

    const directorySelect = await screen.findByLabelText("Directory");
    await waitFor(() => expect(screen.getByRole("option", { name: "/tournaments" })).toBeInTheDocument());
    fireEvent.change(directorySelect, { target: { value: "/tournaments" } });
    fireEvent.change(screen.getByLabelText("Filename"), { target: { value: "regional.db" } });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createCalled).toBe(true));
    expect(await screen.findByRole("status")).toHaveTextContent("Starting tournament…");
  });

  it("pre-fills the filename with a timestamped default when entering the create screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/picker/directories") return jsonResponse({ allowed_directories: [] });
        throw new Error(`unexpected request: ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));

    // Exact formatting is covered by generateDefaultFilename's own unit
    // tests above; this only needs to confirm the field is pre-filled with
    // a value of that shape, without coupling to the real current time.
    const input = (await screen.findByLabelText("Filename")) as HTMLInputElement;
    expect(input.value).toMatch(/^\d{8}T\d{4}-tournament\.db$/);
  });

  it("sanitizes a typed space into an underscore as the organizer types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/picker/directories") return jsonResponse({ allowed_directories: [] });
        throw new Error(`unexpected request: ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));
    fireEvent.change(screen.getByLabelText("Filename"), { target: { value: "my regional.db" } });

    expect(screen.getByLabelText("Filename")).toHaveValue("my_regional.db");
  });

  it("appends .db automatically when the submitted filename is missing it", async () => {
    let createBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/picker/directories" && method === "GET") {
          return jsonResponse({ allowed_directories: ["/tournaments"] });
        }
        if (url === "/api/picker/create" && method === "POST") {
          createBody = JSON.parse(init!.body as string);
          return jsonResponse({ status: "restarting" }, 202);
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));
    const directorySelect = await screen.findByLabelText("Directory");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "/tournaments" })).toBeInTheDocument()
    );
    fireEvent.change(directorySelect, { target: { value: "/tournaments" } });
    fireEvent.change(screen.getByLabelText("Filename"), { target: { value: "regional" } });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // The field is corrected to show what's actually being submitted, in
    // the same synchronous click handler that kicks off the mutation --
    // check it before the mutation resolves and the view switches to the
    // restart-polling screen, which unmounts this field entirely.
    expect(screen.getByLabelText("Filename")).toHaveValue("regional.db");

    await waitFor(() =>
      expect(createBody).toEqual({ directory: "/tournaments", filename: "regional.db" })
    );
  });

  it("adds a directory successfully, updating the directory select's options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/picker/directories" && method === "GET") {
          return jsonResponse({ allowed_directories: [] });
        }
        if (url === "/api/picker/directories" && method === "POST") {
          expect(JSON.parse(init!.body as string)).toEqual({ path: "/new-tournaments" });
          return jsonResponse({ allowed_directories: ["/new-tournaments"] });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a directory..." }));
    fireEvent.change(screen.getByLabelText("New directory path"), {
      target: { value: "/new-tournaments" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "/new-tournaments" })).toBeInTheDocument()
    );
    // The add-directory form collapses back on success.
    expect(screen.queryByLabelText("New directory path")).not.toBeInTheDocument();
  });

  it("shows an inline alert with the ApiError detail when adding a directory fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/picker/directories" && method === "GET") {
          return jsonResponse({ allowed_directories: [] });
        }
        if (url === "/api/picker/directories" && method === "POST") {
          return jsonResponse({ detail: "Not a directory" }, 422);
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a directory..." }));
    fireEvent.change(screen.getByLabelText("New directory path"), {
      target: { value: "/not-a-directory" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not a directory");
  });

  it("shows the restart-timeout alert on the create screen when the restart never completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/picker/directories" && method === "GET") {
          return jsonResponse({ allowed_directories: ["/tournaments"] });
        }
        if (url === "/api/picker/create" && method === "POST") {
          return jsonResponse({ status: "restarting" }, 202);
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Create New Tournament" }));
    const directorySelect = await screen.findByLabelText("Directory");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "/tournaments" })).toBeInTheDocument()
    );
    fireEvent.change(directorySelect, { target: { value: "/tournaments" } });
    fireEvent.change(screen.getByLabelText("Filename"), { target: { value: "regional.db" } });

    // Fake timers are enabled only from here, right before triggering the
    // restart poll -- @testing-library's findBy*/waitFor above poll via a
    // real setTimeout that fake timers would otherwise starve (confirmed:
    // enabling fake timers before those calls hangs every one of them
    // until the test's own timeout). useRestartPoll's own polling loop
    // (setTimeout-scheduled) must start under the fake clock from its
    // very first tick, or a real 500ms poll interval keeps running
    // unaffected in the background while advanceTimersByTimeAsync below
    // advances a separate, empty fake clock -- matching the pattern
    // useRestartPoll.test.ts already uses for the same reason.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Starting tournament…");

    // The server keeps responding 200 to GET /api/picker/directories
    // forever -- picker mode never actually ends -- so the poll must
    // time out rather than silently returning to the form with no
    // explanation (the exact bug Important #1 fixed: before the fix,
    // this alert only rendered on the menu screen, which is never the
    // screen active when a create/open poll times out).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tournament failed to start — check the server logs."
    );
  });

  it("shows the restart-timeout alert on the open screen when the restart never completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/picker/directories" && method === "GET") {
          return jsonResponse({ allowed_directories: ["/tournaments"] });
        }
        if (url.startsWith("/api/picker/tournaments") && method === "GET") {
          return jsonResponse({
            tournaments: [
              {
                filename: "regional.db",
                path: "/tournaments/regional.db",
                size_bytes: 1,
                modified_at: "2026-01-01T00:00:00Z",
              },
            ],
          });
        }
        if (url === "/api/picker/open" && method === "POST") {
          return jsonResponse({ status: "restarting" }, 202);
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "Open Existing Tournament" }));
    const directorySelect = await screen.findByLabelText("Directory");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "/tournaments" })).toBeInTheDocument()
    );
    fireEvent.change(directorySelect, { target: { value: "/tournaments" } });

    const fileSelect = await screen.findByLabelText("Tournament file");
    await waitFor(() => expect(screen.getByRole("option", { name: "regional.db" })).toBeInTheDocument());
    fireEvent.change(fileSelect, { target: { value: "/tournaments/regional.db" } });

    // See the create-screen test above for why fake timers are enabled
    // only at this point, right before triggering the restart poll.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Starting tournament…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tournament failed to start — check the server logs."
    );
  });
});
