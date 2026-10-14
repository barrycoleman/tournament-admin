import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DevicesRoute } from "../../src/routes/DevicesRoute";
import type { DeviceRead } from "../../src/devices/useDevices";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function device(overrides: Partial<DeviceRead>): DeviceRead {
  return {
    id: 1,
    name: "Device",
    role: "scorer",
    status: "active",
    paired_at: minutesAgo(60),
    paired_by: "admin",
    last_seen_at: minutesAgo(0),
    disabled_at: null,
    ...overrides,
  };
}

let devices: DeviceRead[];

function stub(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (key === "GET /api/devices") return devices as never;
    if (key === "GET /api/devices/settings") return { idle_minutes: 240 } as never;
    if (key === "PUT /api/devices/settings") return options?.body as never;
    if (key === "GET /api/pairing/codes/KX49TM")
      return { code: "KX49TM", suggested_name: "Tablet 3", expires_at: minutesAgo(-5) } as never;
    const match = /^(PATCH|POST|DELETE) \/api\/devices\/(\d+)(\/(disable|enable))?$/.exec(key);
    if (match) {
      const found = devices.find((d) => d.id === Number(match[2]));
      if (match[1] === "DELETE") return undefined as never;
      return { ...found, ...(options?.body as object) } as never;
    }
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute(path = "/devices") {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <DevicesRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const devicesFetches = () => vi.mocked(apiRequest).mock.calls.filter(([path, options]) => path === "/api/devices" && !options).length;

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByRole("cell", { name });
  return cell.closest("tr") as HTMLElement;
}

describe("DevicesRoute", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    vi.mocked(useRealtimeChannel).mockReset();
    vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
    devices = [
      device({ id: 1, name: "Pit TV", role: "display_device", status: "active", last_seen_at: minutesAgo(3) }),
      device({ id: 2, name: "Tablet 1", role: "scorer", status: "idle", last_seen_at: minutesAgo(0.2) }),
      device({ id: 3, name: "Tablet 2", role: "front_desk", status: "disabled", disabled_at: minutesAgo(1) }),
    ];
    stub();
  });

  it("lists devices with their role, status and when they were last seen", async () => {
    renderRoute();
    const pit = await rowFor("Pit TV");
    expect(within(pit).getByText("Display")).toBeInTheDocument();
    expect(within(pit).getByText("Active")).toBeInTheDocument();
    expect(within(pit).getByText(/3 min/)).toBeInTheDocument();
    const tablet1 = await rowFor("Tablet 1");
    expect(within(tablet1).getByText("Scorer")).toBeInTheDocument();
    expect(within(tablet1).getByText("Idle")).toBeInTheDocument();
    expect(within(tablet1).getByText("just now")).toBeInTheDocument();
    const tablet2 = await rowFor("Tablet 2");
    expect(within(tablet2).getByText("Check-in")).toBeInTheDocument();
    expect(within(tablet2).getByText("Disabled")).toBeInTheDocument();
  });

  it("says when no devices are paired", async () => {
    devices = [];
    renderRoute();
    expect(await screen.findByText("No devices are paired yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("edits a device's name and role, and shows a duplicate-name refusal in the dialog", async () => {
    renderRoute();
    fireEvent.click(within(await rowFor("Pit TV")).getByRole("button", { name: "Edit" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Edit Pit TV" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Device name")).toHaveValue("Pit TV");
    expect(within(dialog).getByLabelText("Role")).toHaveValue("display_device");
    fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: "Field TV" } });
    fireEvent.change(within(dialog).getByLabelText("Role"), { target: { value: "referee" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/devices/1", {
        method: "PATCH",
        body: { name: "Field TV", role: "referee" },
      })
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    stub({
      "PATCH /api/devices/2": new ApiError(409, "A device with that name already exists.", {
        detail: "A device with that name already exists.",
      }),
    });
    fireEvent.click(within(await rowFor("Tablet 1")).getByRole("button", { name: "Edit" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: "Pit TV" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A device with that name already exists.");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("disables an active device and enables an idle or disabled one", async () => {
    renderRoute();
    const pit = await rowFor("Pit TV");
    expect(within(pit).queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
    fireEvent.click(within(pit).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/devices/1/disable", { method: "POST" }));

    const idle = await rowFor("Tablet 1");
    expect(within(idle).queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
    fireEvent.click(within(idle).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/devices/2/enable", { method: "POST" }));

    fireEvent.click(within(await rowFor("Tablet 2")).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/devices/3/enable", { method: "POST" }));
  });

  it("asks before deleting and deletes on confirm", async () => {
    renderRoute();
    fireEvent.click(within(await rowFor("Pit TV")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete Pit TV? It will need to be paired again.");
    expect(apiRequest).not.toHaveBeenCalledWith("/api/devices/1", { method: "DELETE" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/devices/1", { method: "DELETE" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("shows the idle setting, refuses values out of range, and saves", async () => {
    renderRoute();
    const input = screen.getByLabelText("Disable operator devices after this many minutes without activity");
    await waitFor(() => expect(input).toHaveValue(240));
    expect(input).toHaveAttribute("min", "15");
    expect(input).toHaveAttribute("max", "1440");
    const save = screen.getByRole("button", { name: "Save" });
    const puts = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path, options]) => path === "/api/devices/settings" && options?.method === "PUT");

    fireEvent.change(input, { target: { value: "14" } });
    expect((input as HTMLInputElement).validity.rangeUnderflow).toBe(true);
    fireEvent.click(save);
    fireEvent.change(input, { target: { value: "1441" } });
    expect((input as HTMLInputElement).validity.rangeOverflow).toBe(true);
    fireEvent.click(save);
    expect(puts()).toHaveLength(0);

    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/devices/settings", { method: "PUT", body: { idle_minutes: 30 } })
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("passes a ?pair= code to the pair form", async () => {
    renderRoute("/devices?pair=KX49TM");
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/pairing/codes/KX49TM"));
    expect(screen.getByLabelText("Pairing code")).toHaveValue("KX49TM");
  });

  it("refetches the list on a devices_changed event", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    renderRoute();
    await rowFor("Pit TV");
    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    const before = devicesFetches();
    act(() => onEvent?.({ event: "devices_changed", data: {} } as RealtimeEvent));
    await waitFor(() => expect(devicesFetches()).toBeGreaterThan(before));
  });
});
