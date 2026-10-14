import { useEffect, useRef } from "react";

const DEVICE_CHANGED = 4403;
const POLICY_VIOLATION = 1008;
const RECONNECT_MS = 3_000;

/** Keeps the active-session socket open while signed in. A 4403 close means
 * this device was disabled, deleted or changed role, and a 1008 close means
 * the server refused it, so either signs in again. Any other close or a
 * failed connect reports the server unreachable and reconnects; an open
 * socket reports it reachable. */
export function useDeviceSocket(
  accessToken: string | null,
  onDeviceChanged: () => void,
  onReachability: (reachable: boolean) => void
): void {
  const callbacks = useRef({ onDeviceChanged, onReachability });
  callbacks.current = { onDeviceChanged, onReachability };

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
        if (!stopped) callbacks.current.onReachability(true);
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
