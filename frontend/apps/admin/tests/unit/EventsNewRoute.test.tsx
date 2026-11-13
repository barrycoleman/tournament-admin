import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { EventsNewRoute } from "../../src/routes/EventsNewRoute";

const login = vi.fn();

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useAuth: () => ({ login }) };
});
import { apiRequest } from "@tournament-admin/shared";
const mock = vi.mocked(apiRequest);

function Where() {
  const { pathname } = useLocation();
  return <p>at {pathname}</p>;
}

function renderNew() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A plain MemoryRouter: a data router's navigation builds a Request whose
  // AbortSignal jsdom's fetch polyfill rejects.
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/events/new"]}>
          <Routes>
            <Route path="/events/new" element={<EventsNewRoute />} />
            <Route path="/" element={<Where />} />
            <Route path="/login" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function submit() {
  fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "Spring Open" } });
  fireEvent.change(screen.getByLabelText(/Initial password/), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "Create event" }));
}

beforeEach(() => {
  mock.mockReset();
  login.mockReset();
});

describe("EventsNewRoute", () => {
  it("creates the event, signs in as admin with the same password and goes home", async () => {
    mock.mockResolvedValue({ id: 1, name: "Spring Open" } as never);
    login.mockResolvedValue(undefined);
    renderNew();
    submit();
    expect(await screen.findByText("at /")).toBeInTheDocument();
    expect(mock).toHaveBeenCalledWith("/api/event", { method: "POST", body: { name: "Spring Open", password: "s3cret" } });
    expect(login).toHaveBeenCalledWith("admin", "s3cret");
  });

  it("falls back to the login page when the automatic sign-in fails", async () => {
    mock.mockResolvedValue({ id: 1, name: "Spring Open" } as never);
    login.mockRejectedValue(new ApiError(401, "Invalid credentials"));
    renderNew();
    submit();
    expect(await screen.findByText("at /login")).toBeInTheDocument();
  });

  it("stays on the form with the error when creating the event fails", async () => {
    mock.mockRejectedValue(new ApiError(409, "An event already exists."));
    renderNew();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("An event already exists.");
    expect(login).not.toHaveBeenCalled();
  });
});
