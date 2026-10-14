import { useCallback, useEffect, useRef, useState } from "react";
import { clearDeviceToken, getDeviceToken, signIn, storeDeviceToken, type DeviceSelf } from "./deviceApi";

export const BLOCKED_RETRY_MS = 30_000;
export const UNREACHABLE_RETRY_MS = 5_000;
const RENEW_BEFORE_EXPIRY_MS = 60_000;
// The server hands a just-paired device its token a moment before the device
// row is committed, so the first sign-in after collecting a fresh token may be
// refused. Only that sign-in is retried; a stored token refused at startup
// means the device is no longer paired.
export const FRESH_SIGN_IN_ATTEMPTS = 3;
export const FRESH_SIGN_IN_RETRY_MS = 1_000;

export type Screen =
  | { kind: "loading" }
  | { kind: "pairing" }
  | { kind: "home"; device: DeviceSelf }
  | { kind: "blocked"; name: string };

export function useDeviceSession() {
  const [screen, setScreen] = useState<Screen>(() => (getDeviceToken() ? { kind: "loading" } : { kind: "pairing" }));
  const [unreachable, setUnreachable] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const freshRetriesLeft = useRef(0);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const deviceToken = getDeviceToken();
    if (!deviceToken) {
      setAccessToken(null);
      setScreen({ kind: "pairing" });
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const result = await signIn(deviceToken);
        if (cancelled) return;
        setUnreachable(false);
        if (result.kind === "unknown" && freshRetriesLeft.current > 0) {
          freshRetriesLeft.current -= 1;
          timer = setTimeout(run, FRESH_SIGN_IN_RETRY_MS);
          return;
        }
        freshRetriesLeft.current = 0;
        if (result.kind === "unknown") {
          clearDeviceToken();
          setAccessToken(null);
          setScreen({ kind: "pairing" });
        } else if (result.kind === "blocked") {
          setAccessToken(null);
          setScreen({ kind: "blocked", name: result.name });
          timer = setTimeout(run, BLOCKED_RETRY_MS);
        } else {
          setAccessToken(result.accessToken);
          setScreen({ kind: "home", device: result.device });
          timer = setTimeout(run, Math.max(result.expiresIn * 1000 - RENEW_BEFORE_EXPIRY_MS, 5_000));
        }
      } catch {
        // Anything unexpected is retried like a lost connection: a TV has no
        // keyboard, so it must never get stuck on "Connecting…".
        if (cancelled) return;
        setUnreachable(true);
        timer = setTimeout(run, UNREACHABLE_RETRY_MS);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt]);

  const paired = useCallback((deviceToken: string) => {
    storeDeviceToken(deviceToken);
    freshRetriesLeft.current = FRESH_SIGN_IN_ATTEMPTS - 1;
    setScreen({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { screen, unreachable, accessToken, paired, recheck };
}
