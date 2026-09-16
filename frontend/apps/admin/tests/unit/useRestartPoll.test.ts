import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRestartPoll } from "../../src/useRestartPoll";

describe("useRestartPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("calls onReady once the server starts responding 404 (normal mode)", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        return new Response(null, { status: callCount < 3 ? 200 : 404 });
      })
    );
    const onReady = vi.fn();

    const { result } = renderHook(() => useRestartPoll(onReady));
    act(() => {
      result.current.start();
    });

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("moves to timedOut if the server never comes back within the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );
    const onReady = vi.fn();

    const { result } = renderHook(() => useRestartPoll(onReady));
    act(() => {
      result.current.start();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    expect(result.current.status).toBe("timedOut");
    expect(onReady).not.toHaveBeenCalled();
  });
});
