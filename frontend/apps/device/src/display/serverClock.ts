import { createContext, useContext, useEffect, useState } from "react";

export const RESYNC_MS = 10 * 60_000;

/** How far the server's clock is ahead of this device's, in ms. A TV's own
 * clock may be minutes off, so every countdown adds this offset. */
export async function measureOffset(fetchImpl: typeof fetch = fetch): Promise<number> {
  const sent = Date.now();
  const response = await fetchImpl("/api/time-sync");
  const body = (await response.json()) as { server_time: string };
  const received = Date.now();
  return Date.parse(body.server_time) - (sent + received) / 2;
}

/** Measures the offset now, every 10 minutes, and whenever `resyncKey` changes. */
export function useServerClockOffset(resyncKey: unknown): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const measured = await measureOffset();
        if (!cancelled) setOffset(measured);
      } catch {
        // Keep the last offset; the next run tries again.
      }
    };
    void run();
    const id = setInterval(() => void run(), RESYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [resyncKey]);
  return offset;
}

export const ServerClockContext = createContext(0);

/** The server's "now" in ms, re-rendering every `intervalMs`. */
export function useServerNow(intervalMs = 250): number {
  const offset = useContext(ServerClockContext);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const id = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(id);
  }, [offset, intervalMs]);
  return now;
}
