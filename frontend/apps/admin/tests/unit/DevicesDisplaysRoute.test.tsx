import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DevicesDisplaysRoute } from "../../src/routes/DevicesDisplaysRoute";
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
    display_group: null,
    status: "active",
    paired_at: minutesAgo(60),
    paired_by: "admin",
    last_seen_at: minutesAgo(0),
    disabled_at: null,
    binding: null,
    ...overrides,
  };
}

const group = (overrides: Record<string, unknown>) => ({
  session_id: 1,
  field_set_id: 10,
  field_id: null,
  division_id: null,
  screen: null,
  screen_settings: {},
  rotation: null,
  play_sounds: false,
  displays: [],
  ...overrides,
});

const SESSIONS = [
  { id: 1, label: "Saturday", session_date: null, timezone: null, has_scored_matches: false },
  { id: 2, label: "Sunday", session_date: null, timezone: null, has_scored_matches: false },
];

let devices: DeviceRead[];
let displays: Record<string, unknown>;
let activeSessionId: number | null;
let sessions: unknown[];

function stub(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    const routes: Record<string, unknown> = {
      "GET /api/event": {
        id: 1,
        name: "E",
        active_session_id: activeSessionId,
        game_plugin_name: null,
        game_plugin_locked: false,
        created_at: "",
      },
      "GET /api/sessions": sessions,
      "GET /api/divisions": [{ id: 4, name: "Division 1" }],
      "GET /api/server-info": { port: 8000, addresses: [] },
      "GET /api/displays?session_id=1": displays,
      "GET /api/displays?session_id=2": { session_id: 2, groups: [], unassigned: [], has_setup: false },
      "GET /api/devices": devices,
      "GET /api/devices/settings": { idle_minutes: 240 },
      "GET /api/pairing/codes/KX49TM": { code: "KX49TM", suggested_name: "Tablet 3", expires_at: minutesAgo(-5) },
    };
    if (key in routes) return routes[key] as never;
    if (key === "PUT /api/devices/settings") return options?.body as never;
    if (key === "POST /api/devices/pair") {
      const body = options?.body as { name: string; role: string };
      return device({ id: 9, name: body.name, role: body.role }) as never;
    }
    const match = /^(PATCH|POST|DELETE) \/api\/devices\/(\d+)(\/(disable|enable|binding))?$/.exec(key);
    if (match) {
      const found = devices.find((d) => d.id === Number(match[2]));
      if (match[1] === "DELETE") return undefined as never;
      return { ...found, ...(options?.body as object) } as never;
    }
    if (path.startsWith("/api/displays") || path.startsWith("/api/sessions/")) return displays as never;
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
          <DevicesDisplaysRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const devicesFetches = () => vi.mocked(apiRequest).mock.calls.filter(([path, options]) => path === "/api/devices" && !options).length;

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByRole("cell", { name });
  return cell.closest("tr") as HTMLElement;
}

/** Every realtime handler the page registered, so a test event reaches all of them. */
function captureRealtime(): (event: RealtimeEvent) => void {
  const handlers: ((event: RealtimeEvent) => void)[] = [];
  vi.mocked(useRealtimeChannel).mockImplementation((options) => {
    if (options.onEvent) handlers.push(options.onEvent);
    return { connected: true };
  });
  return (event) => handlers.forEach((handler) => handler(event));
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
  activeSessionId = 1;
  sessions = SESSIONS;
  devices = [
    device({ id: 1, name: "Pit TV", role: "display_device", status: "active", last_seen_at: minutesAgo(3) }),
    device({ id: 2, name: "Tablet 1", role: "scorer", status: "idle", last_seen_at: minutesAgo(0.2) }),
    device({ id: 3, name: "Tablet 2", role: "front_desk", status: "disabled", disabled_at: minutesAgo(1) }),
    device({ id: 7, name: "Big TV", role: "display_device" }),
    device({ id: 8, name: "Spare TV", role: "display_device", status: "idle" }),
  ];
  displays = {
    session_id: 1,
    has_setup: true,
    groups: [
      group({
        id: 50,
        kind: "audience",
        name: "Main Fields",
        screen: "logo",
        displays: [{ device_id: 7, name: "Big TV", online: true }],
      }),
      group({ id: 51, kind: "field", name: "Field 1", field_id: 1 }),
      group({
        id: 52,
        kind: "pit",
        name: "Pit TVs",
        field_set_id: null,
        screen: "teamwork_rankings",
        division_id: 4,
      }),
    ],
    unassigned: [{ device_id: 8, name: "Spare TV", online: false }],
  };
  stub();
});

describe("Devices & displays page: layout", () => {
  it("has one heading, the Spots for picker defaulting to the active session, and the server address panel", async () => {
    renderRoute();
    expect(screen.getByRole("heading", { level: 1, name: "Devices & displays" })).toBeInTheDocument();
    await screen.findByRole("option", { name: "Saturday (active)" });
    expect(screen.getByLabelText("Spots for")).toHaveValue("1");
    expect(await screen.findByRole("heading", { name: "Connect a device on this network" })).toBeInTheDocument();
  });

  it("warns that TVs show nothing when no session is active, linking to the first session's Today tab", async () => {
    activeSessionId = null;
    renderRoute();
    const warning = await screen.findByText("TVs show nothing until a session is active.");
    const alert = warning.closest(".alert") as HTMLElement;
    expect(alert).toHaveClass("alert-warning");
    expect(within(alert).getByRole("link")).toHaveAttribute("href", "/sessions/1/today");
  });

  it("links the warning to a new session when there are none", async () => {
    activeSessionId = null;
    sessions = [];
    renderRoute();
    const warning = await screen.findByText("TVs show nothing until a session is active.");
    expect(within(warning.closest(".alert") as HTMLElement).getByRole("link")).toHaveAttribute("href", "/sessions/new");
  });

  it("shows no warning while a session is active", async () => {
    renderRoute();
    await screen.findByRole("option", { name: "Saturday (active)" });
    expect(screen.queryByText("TVs show nothing until a session is active.")).not.toBeInTheDocument();
  });
});

describe("Devices & displays page: TVs and displays", () => {
  it("lists every TV with Connection beside Status, and keeps other devices in their own table", async () => {
    renderRoute();
    const tvs = await screen.findByRole("region", { name: "TVs and displays" });
    const headers = (await within(tvs).findAllByRole("columnheader")).map((h) => h.textContent);
    expect(headers).toEqual(["Name", "Shows", "Connection", "Status", "Last seen", "Actions"]);
    expect(await within(tvs).findByRole("cell", { name: "Pit TV" })).toBeInTheDocument();
    expect(within(tvs).getByRole("cell", { name: "Big TV" })).toBeInTheDocument();
    expect(within(tvs).queryByRole("cell", { name: "Tablet 1" })).not.toBeInTheDocument();
    const others = screen.getByRole("region", { name: "Scorers, referees and other devices" });
    expect(within(others).getByRole("cell", { name: "Tablet 1" })).toBeInTheDocument();
    expect(within(others).queryByRole("cell", { name: "Pit TV" })).not.toBeInTheDocument();
  });

  it("shows each TV's connection from the displays read; a TV missing from it is not connected", async () => {
    renderRoute();
    await waitFor(async () => expect(await rowFor("Big TV")).toHaveTextContent("● Connected"));
    expect(await rowFor("Spare TV")).toHaveTextContent("● Not connected");
    expect(await rowFor("Pit TV")).toHaveTextContent("● Not connected");
  });

  it("shows what each TV shows, and changes it in place", async () => {
    renderRoute();
    const big = await rowFor("Big TV");
    await waitFor(() => expect(within(big).getByLabelText("What Big TV shows")).toHaveValue("50"));
    expect(within(await rowFor("Pit TV")).getByLabelText("What Pit TV shows")).toHaveValue("");
    expect(within(await rowFor("Pit TV")).getByRole("option", { name: "Nothing yet" })).toBeInTheDocument();
    fireEvent.change(within(big).getByLabelText("What Big TV shows"), { target: { value: "52" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 7, group_id: 52 },
      }),
    );
  });

  it("identifies a connected TV and disables Identify for one that isn't", async () => {
    renderRoute();
    const big = await rowFor("Big TV");
    await waitFor(() => expect(within(big).getByRole("button", { name: "Identify Big TV" })).toBeEnabled());
    fireEvent.click(within(big).getByRole("button", { name: "Identify Big TV" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/displays/7/identify", { method: "POST" }));
    const spare = within(await rowFor("Spare TV")).getByRole("button", { name: "Identify Spare TV" });
    expect(spare).toBeDisabled();
    expect(spare).toHaveAttribute("title", "This TV isn't connected");
    fireEvent.click(spare);
    expect(apiRequest).not.toHaveBeenCalledWith("/api/displays/8/identify", { method: "POST" });
  });

  it("says when no TVs are paired", async () => {
    devices = devices.filter((d) => d.role !== "display_device");
    renderRoute();
    expect(await screen.findByText("No TVs are paired yet.")).toBeInTheDocument();
  });
});

describe("Devices & displays page: pairing", () => {
  it("defaults the pair form to TV / display and offers what it shows", async () => {
    renderRoute();
    const form = screen.getByRole("form", { name: "Pair a device" });
    expect(within(form).getByLabelText("Role")).toHaveValue("display_device");
    expect(within(form).getByRole("option", { name: "TV / display" })).toHaveProperty("selected", true);
    const shows = within(form).getByLabelText("Shows");
    expect(within(shows).getByRole("option", { name: "Nothing yet" })).toBeInTheDocument();
    expect(await within(shows).findByRole("option", { name: "Main Fields (audience)" })).toBeInTheDocument();
    expect(within(shows).getByRole("option", { name: "Pit TVs (pit)" })).toBeInTheDocument();
  });

  it("pairs a TV and gives it the chosen spot with the new device's id", async () => {
    renderRoute("/devices?pair=KX49TM");
    const form = screen.getByRole("form", { name: "Pair a device" });
    await waitFor(() => expect(within(form).getByLabelText("Device name")).toHaveValue("Tablet 3"));
    const shows = within(form).getByLabelText("Shows");
    await within(shows).findByRole("option", { name: "Pit TVs (pit)" });
    fireEvent.change(shows, { target: { value: "52" } });
    fireEvent.click(within(form).getByRole("button", { name: "Pair" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 9, group_id: 52 },
      }),
    );
    expect(apiRequest).toHaveBeenCalledWith("/api/devices/pair", {
      method: "POST",
      body: { code: "KX49TM", role: "display_device", name: "Tablet 3" },
    });
    expect(await within(form).findByRole("status")).toHaveTextContent("Paired Tablet 3.");
  });

  it("passes a ?pair= code to the pair form", async () => {
    renderRoute("/devices?pair=KX49TM");
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/pairing/codes/KX49TM"));
    expect(screen.getByLabelText("Pairing code")).toHaveValue("KX49TM");
  });
});

describe("Devices & displays page: device actions", () => {
  it("shows each display's group in the other devices table only for non-display roles", async () => {
    renderRoute();
    const others = await screen.findByRole("region", { name: "Scorers, referees and other devices" });
    expect(within(others).queryByText("Big TV")).not.toBeInTheDocument();
  });

  it("lists devices with their role, status and when they were last seen", async () => {
    renderRoute();
    const pit = await rowFor("Pit TV");
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
    expect(await screen.findByText("No TVs are paired yet.")).toBeInTheDocument();
    expect(screen.getByText("No other devices are paired yet.")).toBeInTheDocument();
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
      }),
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
      expect(apiRequest).toHaveBeenCalledWith("/api/devices/settings", { method: "PUT", body: { idle_minutes: 30 } }),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("refetches the list on a devices_changed event", async () => {
    const send = captureRealtime();
    renderRoute();
    await rowFor("Pit TV");
    expect(vi.mocked(useRealtimeChannel).mock.calls.every(([options]) => options.path === "/ws/active-session")).toBe(true);
    const before = devicesFetches();
    act(() => send({ event: "devices_changed", data: {} } as RealtimeEvent));
    await waitFor(() => expect(devicesFetches()).toBeGreaterThan(before));
  });

  it("shows a scorer's field binding and clears it", async () => {
    devices = [device({ id: 2, name: "Tablet 1", role: "scorer", binding: { field_id: 5, field_name: "Field 2" } })];
    stub({ "DELETE /api/devices/2/binding": undefined });
    renderRoute();
    const row = await rowFor("Tablet 1");
    expect(row).toHaveTextContent("Scoring · Field 2");
    fireEvent.click(within(row).getByRole("button", { name: "Clear Tablet 1's field" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/devices/2/binding", { method: "DELETE" }));
  });

  it("shows nothing in the Group column for an unbound scorer", async () => {
    devices = [device({ id: 2, name: "Tablet 1", role: "scorer" })];
    stub();
    renderRoute();
    const row = await rowFor("Tablet 1");
    expect(within(row).queryByRole("button", { name: /field$/ })).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent("Scoring");
  });

  it("refetches the list on a scorer_binding_changed event", async () => {
    const send = captureRealtime();
    renderRoute();
    await rowFor("Pit TV");
    const before = devicesFetches();
    act(() => send({ event: "scorer_binding_changed", data: { device_id: 2 } } as RealtimeEvent));
    await waitFor(() => expect(devicesFetches()).toBeGreaterThan(before));
  });
});

describe("Devices & displays page: spots", () => {
  it("lists field groups with their audience and field groups, pit groups and unassigned displays", async () => {
    renderRoute();
    const main = await screen.findByRole("region", { name: "Main Fields" });
    expect(within(main).getByText("Big TV")).toBeInTheDocument();
    expect(within(main).getByText("Online")).toBeInTheDocument();
    expect(within(main).getByText("Field 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pit TVs" })).toBeInTheDocument();
    const unassigned = screen.getByRole("region", { name: "Unassigned displays" });
    expect(within(unassigned).getByText("Spare TV")).toBeInTheDocument();
    expect(within(unassigned).getByText("Offline")).toBeInTheDocument();
  });

  it("sets the audience screen and sounds", async () => {
    renderRoute();
    const main = await screen.findByRole("region", { name: "Main Fields" });
    fireEvent.change(within(main).getByLabelText("Audience screen"), { target: { value: "schedule" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", {
        method: "PATCH",
        body: { screen: "schedule" },
      }),
    );
    fireEvent.click(within(main).getByLabelText("Play sounds"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", {
        method: "PATCH",
        body: { play_sounds: true },
      }),
    );
  });

  it("moves and identifies displays", async () => {
    renderRoute();
    const unassigned = await screen.findByRole("region", { name: "Unassigned displays" });
    fireEvent.change(within(unassigned).getByLabelText("Put Spare TV in a group"), { target: { value: "52" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 8, group_id: 52 },
      }),
    );
    const main = screen.getByRole("region", { name: "Main Fields" });
    fireEvent.click(within(main).getByRole("button", { name: "Identify Big TV" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/displays/7/identify", { method: "POST" }));
    fireEvent.change(within(main).getByLabelText("Move Big TV"), { target: { value: "" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 7, group_id: null },
      }),
    );
  });

  it("disables Identify for an offline display and says why", async () => {
    renderRoute();
    const unassigned = await screen.findByRole("region", { name: "Unassigned displays" });
    const identify = within(unassigned).getByRole("button", { name: "Identify Spare TV" });
    expect(identify).toBeDisabled();
    expect(identify).toHaveAttribute("title", "This TV isn't connected");
    fireEvent.click(identify);
    expect(apiRequest).not.toHaveBeenCalledWith("/api/displays/8/identify", { method: "POST" });
  });

  it("adds a pit group", async () => {
    renderRoute();
    fireEvent.change(await screen.findByLabelText("Pit group name"), { target: { value: "Hallway" } });
    fireEvent.click(screen.getByRole("button", { name: "Add pit group" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/pit-groups", {
        method: "POST",
        body: { session_id: 1, name: "Hallway", division_id: null },
      }),
    );
  });

  it("builds and saves a pit rotation", async () => {
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.click(within(pit).getByLabelText("Rotate through screens"));
    fireEvent.click(within(pit).getByRole("button", { name: "Add screen" }));
    fireEvent.change(within(pit).getByLabelText("Screen 2"), { target: { value: "upcoming_matches" } });
    fireEvent.change(within(pit).getByLabelText("Seconds for screen 2"), { target: { value: "30" } });
    expect(within(pit).queryByLabelText("Seconds for screen 1")).not.toBeInTheDocument();
    fireEvent.click(within(pit).getByRole("button", { name: "Save rotation" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/52", {
        method: "PATCH",
        body: {
          rotation: [
            { screen: "teamwork_rankings", settings: {}, seconds: 20 },
            { screen: "upcoming_matches", settings: { count: 3, scope: "division" }, seconds: 30 },
          ],
        },
      }),
    );
  });

  it("deletes a pit group after asking", async () => {
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.click(within(pit).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/52", { method: "DELETE" }));
  });

  it("offers to copy spots whenever another session exists, even one already set up", async () => {
    renderRoute();
    const copy = await screen.findByRole("region", { name: "Copy spots from another session" });
    expect(within(copy).getByRole("option", { name: "Sunday" })).toBeInTheDocument();
  });

  it("offers no copy when there is only one session", async () => {
    sessions = [SESSIONS[0]];
    renderRoute();
    await screen.findByRole("region", { name: "Main Fields" });
    expect(screen.queryByRole("region", { name: "Copy spots from another session" })).not.toBeInTheDocument();
  });

  it("clears the chosen copy source when the page switches sessions, leaving Copy disabled", async () => {
    renderRoute();
    await screen.findByRole("option", { name: "Saturday (active)" });
    fireEvent.change(screen.getByLabelText("Spots for"), { target: { value: "2" } });
    const copy = await screen.findByRole("region", { name: "Copy spots from another session" });
    fireEvent.change(within(copy).getByLabelText("Copy from"), { target: { value: "1" } });
    expect(within(copy).getByRole("button", { name: "Copy displays" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Spots for"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Spots for"), { target: { value: "2" } });
    const again = await screen.findByRole("region", { name: "Copy spots from another session" });
    expect(within(again).getByLabelText("Copy from")).toHaveValue("");
    expect(within(again).getByRole("button", { name: "Copy displays" })).toBeDisabled();
  });

  it("copies another session's displays into an empty session and lists those it couldn't place", async () => {
    stub({
      "POST /api/sessions/2/copy-displays": {
        unplaced: [{ device_id: 9, device_name: "Lost TV", source_group_name: "Field 3" }],
      },
    });
    renderRoute();
    await screen.findByRole("option", { name: "Saturday (active)" });
    fireEvent.change(screen.getByLabelText("Spots for"), { target: { value: "2" } });
    const copy = await screen.findByRole("region", { name: "Copy spots from another session" });
    fireEvent.change(within(copy).getByLabelText("Copy from"), { target: { value: "1" } });
    fireEvent.click(within(copy).getByRole("button", { name: "Copy displays" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/2/copy-displays", {
        method: "POST",
        body: { source_session_id: 1 },
      }),
    );
    expect(await screen.findByText("Lost TV (was in Field 3)")).toBeInTheDocument();
  });

  it("shows the server's reason when changing a pit screen is rejected", async () => {
    const base = vi.mocked(apiRequest).getMockImplementation()!;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") throw new ApiError(409, "That screen needs a division");
      return base(path, options as never);
    });
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.change(within(pit).getByLabelText("Screen"), { target: { value: "schedule" } });
    expect(await within(pit).findByRole("alert")).toHaveTextContent("That screen needs a division");
  });
});
