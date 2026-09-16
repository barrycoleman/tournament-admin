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

  it('with target "picker", calls onReady only once the server starts responding 200 again (picker mode), not on the pre-restart 404s', async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        // Mirrors the real switch sequence: the still-normal old process
        // 404s a couple of times before the restart, then the port is
        // briefly unreachable (simulated here as another 404 rather than
        // a network error, since only the status-based branch matters),
        // then the new picker-mode process starts responding 200 with a
        // real JSON body (apiRequest parses the body on any 200).
        return callCount < 3
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ allowed_directories: [] }), { status: 200 });
      })
    );
    const onReady = vi.fn();

    const { result } = renderHook(() => useRestartPoll(onReady, "picker"));
    act(() => {
      result.current.start();
    });

    // `start()` above already fired the first tick synchronously
    // (callCount === 1, a 404) before any timer advance. One more 500ms
    // advance fires the second tick (callCount === 2, still a 404, since
    // the mock returns 404 while callCount < 3) -- onReady must NOT fire
    // yet, or this is the exact bug being fixed (the pre-fix code fires
    // onReady on the very first 404 it sees, regardless of target).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onReady).not.toHaveBeenCalled();

    // The next 500ms advance fires the third tick (callCount === 3, the
    // mock's threshold for switching to 200 -- the restarted process, now
    // in picker mode) -- onReady must fire now.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
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
