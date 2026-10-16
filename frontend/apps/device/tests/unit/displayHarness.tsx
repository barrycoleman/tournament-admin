import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import "../../src/i18nSetup";
import { DisplayApp } from "../../src/display/DisplayApp";
import { createEventBus } from "../../src/display/events";

export type Route = unknown | ((url: string) => unknown);

/** Serves exact request paths as JSON; anything else is a 404. GET
 * /api/time-sync answers with the server clock `serverOffsetMs` ahead of
 * this device's clock. */
export function serveDisplay(routes: Record<string, Route>, { serverOffsetMs = 0 } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/time-sync") {
      const server_time = new Date(Date.now() + serverOffsetMs).toISOString();
      return new Response(JSON.stringify({ server_time, boot_id: "boot" }), { status: 200 });
    }
    if (!(url in routes)) return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
    const value = routes[url];
    const body = typeof value === "function" ? (value as (u: string) => unknown)(url) : value;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

export function renderDisplay({ unreachable = false } = {}) {
  const bus = createEventBus();
  const utils = render(
    <DisplayApp
      accessToken="token"
      device={{ id: 7, name: "Big TV", role: "display_device", status: "active" }}
      bus={bus}
      unreachable={unreachable}
    />
  );
  const emit = (event: string, data: unknown = {}) => act(() => bus.emit({ event, data }));
  return { ...utils, bus, emit };
}
