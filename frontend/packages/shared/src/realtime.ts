import { useEffect, useRef, useState } from "react";
import { getStoredTokens } from "./tokenStorage";

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface UseRealtimeChannelOptions {
  /** Path of the WebSocket endpoint, e.g. "/ws/active-session". */
  path: string;
  onEvent?: (event: RealtimeEvent) => void;
  enabled?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function useRealtimeChannel({
  path,
  onEvent,
  enabled = true,
}: UseRealtimeChannelOptions): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return undefined;

    let socket: WebSocket | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      const tokens = getStoredTokens();
      if (!tokens) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}${path}?token=${encodeURIComponent(
        tokens.accessToken
      )}`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        setConnected(true);
      };
      socket.onmessage = (message: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(message.data) as RealtimeEvent;
          onEventRef.current?.(parsed);
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [path, enabled]);

  return { connected };
}
