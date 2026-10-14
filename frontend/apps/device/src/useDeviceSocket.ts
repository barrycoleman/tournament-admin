import { useEffect, useRef } from "react";

const DEVICE_CHANGED = 4403;
const RECONNECT_MS = 3_000;

/** Keeps the active-session socket open while signed in. A 4403 close means
 * this device was disabled, deleted or changed role, so it signs in again. */
export function useDeviceSocket(accessToken: string | null, onDeviceChanged: () => void): void {
  const callback = useRef(onDeviceChanged);
  callback.current = onDeviceChanged;

  useEffect(() => {
    if (!accessToken) return undefined;
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/active-session?token=${encodeURIComponent(accessToken)}`
      );
      socket.onclose = (event: CloseEvent | { code: number }) => {
        if (stopped) return;
        if (event.code === DEVICE_CHANGED || event.code === 1008) {
          callback.current();
          return;
        }
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [accessToken]);
}
