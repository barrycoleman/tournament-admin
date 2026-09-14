import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeTokens } from "../src/tokenStorage";
import { useRealtimeChannel, type RealtimeEvent } from "../src/realtime";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function Probe({ onEvent }: { onEvent: (event: RealtimeEvent) => void }) {
  const { connected } = useRealtimeChannel({ path: "/ws/active-session", onEvent });
  return <p>connected: {String(connected)}</p>;
}

beforeEach(() => {
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  storeTokens({ accessToken: "token-abc", refreshToken: "r", expiresAt: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useRealtimeChannel", () => {
  it("connects with the stored access token in the URL", () => {
    render(<Probe onEvent={() => {}} />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/ws/active-session?token=token-abc");
  });

  it("calls onEvent with the parsed JSON payload of each message", async () => {
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} />);
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: "active_session_changed" }) });
    });

    expect(onEvent).toHaveBeenCalledWith({ type: "active_session_changed" });
  });

  it("reports connected after onopen and not connected after onclose", async () => {
    const { getByText } = render(<Probe onEvent={() => {}} />);
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.onopen?.();
    });
    await waitFor(() => expect(getByText("connected: true")).toBeInTheDocument());

    act(() => {
      socket.onclose?.();
    });
    await waitFor(() => expect(getByText("connected: false")).toBeInTheDocument());
  });

  it("reconnects after a close, opening a second socket", async () => {
    vi.useFakeTimers();
    render(<Probe onEvent={() => {}} />);
    const firstSocket = FakeWebSocket.instances[0];

    act(() => {
      firstSocket.onclose?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
