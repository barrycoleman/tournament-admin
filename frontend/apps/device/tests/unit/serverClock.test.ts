import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerClockContext, measureOffset, useServerNow } from "../../src/display/serverClock";

afterEach(() => vi.useRealTimers());

describe("measureOffset", () => {
  it("is how far the server clock is ahead of this device's, using the round trip's midpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T16:00:00Z"));
    const fetchImpl = vi.fn(async () => {
      // The answer takes 2 s; the server reads its clock halfway through.
      vi.setSystemTime(new Date("2026-11-07T16:00:02Z"));
      return new Response(JSON.stringify({ server_time: "2026-11-07T16:02:01Z", boot_id: "b" }));
    });
    expect(await measureOffset(fetchImpl as unknown as typeof fetch)).toBe(120_000);
  });

  it("is negative when the device's clock runs ahead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T16:05:00Z"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ server_time: "2026-11-07T16:00:00Z", boot_id: "b" })));
    expect(await measureOffset(fetchImpl as unknown as typeof fetch)).toBe(-300_000);
  });
});

describe("useServerNow", () => {
  it("reads the device clock plus the measured offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T16:00:00Z"));
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ServerClockContext.Provider, { value: 120_000 }, children);
    const { result } = renderHook(() => useServerNow(), { wrapper });
    expect(result.current).toBe(Date.parse("2026-11-07T16:02:00Z"));
  });
});
