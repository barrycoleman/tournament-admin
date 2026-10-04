import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePlanPreview } from "../../src/schedule/usePlanPreview";
import type { PlanRequest } from "../../src/schedule/planDraft";
import type { PlanResponse } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

function request(matchesPerTeam: number): PlanRequest {
  return {
    session_id: 1,
    scheduler_plugin_name: "balanced",
    rounds: [{ round_type: "qualification", target_matches_per_team: matchesPerTeam, cycle_time_seconds: 300 }],
    dry_run: true,
  };
}

function response(matchCount: number): PlanResponse {
  return {
    fits: true,
    rounds: [
      {
        round_type: "qualification",
        schedule_generation_id: null,
        match_count: matchCount,
        slot_count: matchCount,
        first_start: "2026-11-07T17:00:00Z",
        last_end: "2026-11-07T18:00:00Z",
      },
    ],
    overflow: null,
  };
}

interface Pending {
  body: PlanRequest;
  resolve: (value: PlanResponse) => void;
}

let pending: Pending[];

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockImplementation(
    (_path: string, options?: unknown) =>
      new Promise((resolve) => {
        pending.push({ body: (options as { body: PlanRequest }).body, resolve: resolve as Pending["resolve"] });
      }) as never
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function renderPreview(initial: PlanRequest | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(({ req }: { req: PlanRequest | null }) => usePlanPreview(req), {
    initialProps: { req: initial },
    wrapper,
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Resolves one in-flight dry run and lets the query cache notify its observers. */
async function answer(index: number, value: PlanResponse) {
  pending[index].resolve(value);
  await advance(1);
}

describe("usePlanPreview", () => {
  it("debounces rapid edits into one dry run for the latest draft", async () => {
    // The draft present on mount is checked straight away.
    const { rerender, result } = renderPreview(request(1));
    await advance(1);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(pending[0].body).toEqual(request(1));
    await answer(0, response(1));
    expect(result.current.settled).toBe(true);

    // Edits within 400 ms of each other wait for the last one.
    rerender({ req: request(2) });
    await advance(100);
    rerender({ req: request(3) });
    await advance(100);
    rerender({ req: request(4) });
    await advance(399);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(result.current.settled).toBe(false);
    await advance(1);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(pending[1].body).toEqual(request(4));
    await answer(1, response(4));
    expect(result.current.data).toEqual(response(4));
    expect(result.current.settled).toBe(true);
  });

  it("reports only the latest draft's answer when an older one arrives late", async () => {
    const { rerender, result } = renderPreview(request(1));
    await advance(400);
    expect(pending).toHaveLength(1);

    rerender({ req: request(2) });
    expect(result.current.settled).toBe(false);
    await advance(400);
    expect(pending).toHaveLength(2);
    expect(pending[1].body).toEqual(request(2));

    await answer(1, response(2));
    expect(result.current.data).toEqual(response(2));
    expect(result.current.settled).toBe(true);

    // The first draft's answer comes back after the second's.
    await answer(0, response(1));
    expect(result.current.data).toEqual(response(2));
    expect(result.current.settled).toBe(true);
  });

  it("never reports an older draft's answer as settled while the latest is still in flight", async () => {
    const { rerender, result } = renderPreview(request(1));
    await advance(400);
    rerender({ req: request(2) });
    await advance(400);
    expect(pending).toHaveLength(2);

    await answer(0, response(1));
    expect(result.current.settled).toBe(false);

    await answer(1, response(2));
    expect(result.current.data).toEqual(response(2));
    expect(result.current.settled).toBe(true);
  });

  it("reports nothing when there is no draft to check", async () => {
    const { result } = renderPreview(null);
    await advance(1000);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(result.current).toEqual({ data: undefined, error: null, settled: false });
  });
});
