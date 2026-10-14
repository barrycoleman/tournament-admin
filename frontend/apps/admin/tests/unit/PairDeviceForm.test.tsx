import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { PairDeviceForm } from "../../src/devices/PairDeviceForm";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const CHECK = { code: "KX49TM", suggested_name: "Tablet 3", expires_at: "2026-10-13T12:05:00Z" };

function deviceRow(name: string, role: string) {
  return {
    id: 7,
    name,
    role,
    status: "active",
    paired_at: "2026-10-13T12:00:00Z",
    paired_by: "admin",
    last_seen_at: "2026-10-13T12:00:00Z",
    disabled_at: null,
  };
}

function stub(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (key === "GET /api/pairing/codes/KX49TM") return CHECK as never;
    if (key === "POST /api/devices/pair") {
      const body = options?.body as { name: string; role: string };
      return deviceRow(body.name, body.role) as never;
    }
    if (key === "GET /api/devices") return [] as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderForm(initialCode?: string) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PairDeviceForm initialCode={initialCode} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const checkCalls = () =>
  vi.mocked(apiRequest).mock.calls.filter(([path]) => String(path).startsWith("/api/pairing/codes/"));

function typeCode(value: string) {
  fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value } });
}

describe("PairDeviceForm", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    stub();
  });

  it("checks a loosely typed code once and fills in the suggested name", async () => {
    renderForm();
    typeCode("kx4-9tm");
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveValue("Tablet 3"));
    expect(checkCalls()).toEqual([["/api/pairing/codes/KX49TM"]]);
    expect(screen.getByRole("button", { name: "Pair" })).toBeEnabled();
  });

  it("says an unknown code isn't valid and keeps Pair disabled", async () => {
    stub({
      "GET /api/pairing/codes/AAAAAA": new ApiError(404, "That code isn't valid or has expired.", {
        detail: "That code isn't valid or has expired.",
      }),
    });
    renderForm();
    typeCode("aaaaaa");
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Pit TV" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't valid or has expired.");
    expect(screen.getByRole("button", { name: "Pair" })).toBeDisabled();
  });

  it("pairs with the code, role and name, says so, and clears the form", async () => {
    renderForm();
    typeCode("KX4 9TM");
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveValue("Tablet 3"));
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/devices/pair", {
        method: "POST",
        body: { code: "KX49TM", role: "scorer", name: "Tablet 3" },
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Paired Tablet 3.");
    expect(screen.getByLabelText("Pairing code")).toHaveValue("");
    expect(screen.getByLabelText("Device name")).toHaveValue("");
  });

  async function pairAfterACheck(error: ApiError) {
    stub({ "POST /api/devices/pair": error });
    renderForm();
    typeCode("KX49TM");
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveValue("Tablet 3"));
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
  }

  it("translates a duplicate-name refusal from Pair", async () => {
    await pairAfterACheck(new ApiError(409, "server text", { detail: "server text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A device with that name already exists.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("server text");
    expect(screen.getByLabelText("Pairing code")).toHaveValue("KX49TM");
  });

  it("translates a code that expired between the check and Pair", async () => {
    await pairAfterACheck(new ApiError(404, "server text", { detail: "server text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't valid or has expired.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("server text");
  });

  it("shows the server's message for any other Pair failure", async () => {
    await pairAfterACheck(new ApiError(422, "Role isn't pairable", { detail: "Role isn't pairable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Role isn't pairable");
  });

  it("sends display_device when Display is chosen", async () => {
    renderForm();
    typeCode("KX49TM");
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveValue("Tablet 3"));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "display_device" } });
    expect(screen.getByRole("option", { name: "Display" })).toHaveProperty("selected", true);
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/devices/pair", {
        method: "POST",
        body: { code: "KX49TM", role: "display_device", name: "Tablet 3" },
      })
    );
  });

  it("checks an initial code straight away", async () => {
    renderForm("KX49TM");
    await waitFor(() => expect(checkCalls()).toEqual([["/api/pairing/codes/KX49TM"]]));
    expect(screen.getByLabelText("Pairing code")).toHaveValue("KX49TM");
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveValue("Tablet 3"));
  });

  it("keeps a name the admin typed when the check suggests one", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Pit TV" } });
    typeCode("KX49TM");
    await waitFor(() => expect(screen.getByRole("button", { name: "Pair" })).toBeEnabled());
    expect(screen.getByLabelText("Device name")).toHaveValue("Pit TV");
  });
});
