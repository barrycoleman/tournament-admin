import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerClockContext, measureOffset, useServerClockOffset, useServerNow } from "../../src/display/serverClock";

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

describe("a bad time-sync answer", () => {
  const bad: [string, () => Response][] = [
    ["an error status", () => new Response(JSON.stringify({ detail: "down" }), { status: 503 })],
    ["a body without the time", () => new Response(JSON.stringify({ detail: "odd" }), { status: 200 })],
  ];
  for (const [name, answer] of bad) {
    it(`measureOffset rejects ${name}`, async () => {
      const fetchImpl = vi.fn(async () => answer());
      await expect(measureOffset(fetchImpl as unknown as typeof fetch)).rejects.toThrow();
    });

    it(`the offset keeps its last good value after ${name}`, async () => {
      let good = true;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        good ? new Response(JSON.stringify({ server_time: new Date(Date.now() + 120_000).toISOString(), boot_id: "b" })) : answer()
      );
      const { result, rerender } = renderHook(({ key }) => useServerClockOffset(key), { initialProps: { key: 0 } });
      await waitFor(() => expect(Math.abs(result.current - 120_000)).toBeLessThan(2_000));
      const before = result.current;
      good = false;
      spy.mockClear();
      rerender({ key: 1 });
      await waitFor(() => expect(spy).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current).toBe(before);
      spy.mockRestore();
    });
  }
});
