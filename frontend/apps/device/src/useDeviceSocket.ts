import { useEffect, useRef } from "react";
import type { LiveEvent } from "./display/events";

const DEVICE_CHANGED = 4403;
const POLICY_VIOLATION = 1008;
const RECONNECT_MS = 3_000;

/** Keeps the active-session socket open while signed in. A 4403 close means
 * this device was disabled, deleted or changed role, and a 1008 close means
 * the server refused it, so either signs in again. Any other close or a
 * failed connect reports the server unreachable and reconnects; an open
 * socket reports it reachable. Every message is passed to `onMessage`, and
 * every successful open to `onOpen`, so display mode can refresh after a
 * reconnect. */
export function useDeviceSocket(
  accessToken: string | null,
  onDeviceChanged: () => void,
  onReachability: (reachable: boolean) => void,
  onMessage?: (message: LiveEvent) => void,
  onOpen?: () => void
): void {
  const callbacks = useRef({ onDeviceChanged, onReachability, onMessage, onOpen });
  callbacks.current = { onDeviceChanged, onReachability, onMessage, onOpen };

  useEffect(() => {
    if (!accessToken) return undefined;
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      callbacks.current.onReachability(false);
      timer = setTimeout(connect, RECONNECT_MS);
    };
    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        socket = new WebSocket(
          `${protocol}//${window.location.host}/ws/active-session?token=${encodeURIComponent(accessToken ?? "")}`
        );
      } catch {
        if (!stopped) retry();
        return;
      }
      socket.onopen = () => {
        if (stopped) return;
        callbacks.current.onReachability(true);
        callbacks.current.onOpen?.();
      };
      socket.onmessage = (message: MessageEvent<string>) => {
        if (stopped) return;
        try {
          const parsed = JSON.parse(message.data) as LiveEvent;
          if (parsed && typeof parsed.event === "string") callbacks.current.onMessage?.(parsed);
        } catch {
          // A frame that isn't JSON is ignored.
        }
      };
      socket.onclose = (event: CloseEvent | { code: number }) => {
        if (stopped) return;
        if (event.code === DEVICE_CHANGED || event.code === POLICY_VIOLATION) {
          callbacks.current.onDeviceChanged();
          return;
        }
        retry();
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      // A closed socket says nothing about the server any more.
      callbacks.current.onReachability(true);
    };
  }, [accessToken]);
}
