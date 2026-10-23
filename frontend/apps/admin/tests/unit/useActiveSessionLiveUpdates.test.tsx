import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { RealtimeEvent } from "@tournament-admin/shared";
import { useActiveSessionLiveUpdates } from "../../src/orientation/useActiveSessionLiveUpdates";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, useRealtimeChannel: vi.fn() };
});

import { useRealtimeChannel } from "@tournament-admin/shared";

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  renderHook(() => useActiveSessionLiveUpdates(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  const options = vi.mocked(useRealtimeChannel).mock.lastCall![0];
  return { invalidate, send: (event: RealtimeEvent) => options.onEvent?.(event), path: options.path };
}

describe("useActiveSessionLiveUpdates", () => {
  it("invalidates the event and sessions when the active session changes, including to none", () => {
    for (const data of [{ active_session_id: 4 }, { active_session_id: null }]) {
      const { invalidate, send, path } = setup();
      expect(path).toBe("/ws/active-session");
      send({ event: "active_session_changed", data } as RealtimeEvent);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["event"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    }
  });

  it("ignores other events", () => {
    const { invalidate, send } = setup();
    send({ event: "display_changed", data: {} } as RealtimeEvent);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
