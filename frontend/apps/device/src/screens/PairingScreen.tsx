import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { formatCode, pairingLink, pollPairing, requestPairingCode, type PairingCode } from "../deviceApi";
import { UNREACHABLE_RETRY_MS } from "../useDeviceSession";

const POLL_MS = 2_000;

interface Props {
  onPaired: (deviceToken: string) => void;
  onReachability: (reachable: boolean) => void;
}

export function PairingScreen({ onPaired, onReachability }: Props) {
  const { t } = useTranslation();
  const [code, setCode] = useState<PairingCode | null>(null);
  // Expiry is counted on this device's own clock from expires_in, because a
  // TV's clock is often wrong; expires_at is never compared with Date.now().
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);

  const callbacks = useRef({ onPaired, onReachability });
  callbacks.current = { onPaired, onReachability };
  // The server hands a token over exactly once, so once any code (current or
  // previous) answers "paired" that is final for this screen.
  const collected = useRef(false);
  const mounted = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // The code on screen. A code whose countdown ran out stays polled until the
  // server forgets it (its grace after expiry), but only the current code's
  // "expired" answer asks for a new one.
  const currentId = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    const pending = timers.current;
    return () => {
      mounted.current = false;
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (code) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.current.delete(id);
        fn();
      }, ms);
      timers.current.add(id);
    };

    // Polls one code, one request at a time, until it is paired or the server
    // has forgotten it.
    const poll = (target: PairingCode) => {
      const tick = async () => {
        if (!mounted.current || collected.current) return;
        let result;
        try {
          result = await pollPairing(target);
        } catch {
          if (!mounted.current || collected.current) return;
          if (currentId.current === target.id) callbacks.current.onReachability(false);
          later(() => void tick(), POLL_MS);
          return;
        }
        if (!mounted.current || collected.current) return;
        if (currentId.current === target.id) callbacks.current.onReachability(true);
        if (result.status === "paired") {
          collected.current = true;
          callbacks.current.onPaired(result.device_token);
        } else if (result.status === "expired") {
          if (currentId.current === target.id) {
            currentId.current = null;
            setCode(null);
          }
        } else {
          later(() => void tick(), POLL_MS);
        }
      };
      later(() => void tick(), POLL_MS);
    };

    const fetchCode = async () => {
      try {
        const next = await requestPairingCode();
        if (cancelled || collected.current) return;
        callbacks.current.onReachability(true);
        currentId.current = next.id;
        setDeadline(Date.now() + next.expires_in * 1000);
        setNow(Date.now());
        setCode(next);
        poll(next);
      } catch {
        // Anything unexpected is retried like a lost connection: a TV has no
        // keyboard to recover with.
        if (cancelled) return;
        callbacks.current.onReachability(false);
        timer = setTimeout(fetchCode, UNREACHABLE_RETRY_MS);
      }
    };
    void fetchCode();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (code && now >= deadline) {
      // Show a new code; the old one keeps being polled (see poll above).
      currentId.current = null;
      setCode(null);
    }
  }, [code, now, deadline]);

  // Drawn at commit, so the QR is on the canvas as soon as the code is shown.
  useLayoutEffect(() => {
    if (code && canvas.current) {
      void QRCode.toCanvas(canvas.current, pairingLink(window.location.origin, code.code), { width: 240, margin: 1 });
    }
  }, [code]);

  return (
    <section className="pairing">
      <h1>{t("pairing.heading")}</h1>
      {code && (
        <>
          <p className="pairing__code" data-testid="pairing-code">
            {formatCode(code.code)}
          </p>
          <canvas ref={canvas} className="pairing__qr" role="img" aria-label={t("pairing.qrLabel")} />
          <p className="pairing__instructions">{t("pairing.instructions")}</p>
          <p className="pairing__countdown">
            {t("pairing.expiresIn", { seconds: Math.max(0, Math.ceil((deadline - now) / 1000)) })}
          </p>
        </>
      )}
    </section>
  );
}
