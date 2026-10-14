import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { Unreachable, formatCode, pairingLink, pollPairing, requestPairingCode, type PairingCode } from "../deviceApi";
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

  useEffect(() => {
    if (code) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchCode = async () => {
      try {
        const next = await requestPairingCode();
        if (cancelled) return;
        onReachability(true);
        setDeadline(Date.now() + next.expires_in * 1000);
        setNow(Date.now());
        setCode(next);
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof Unreachable)) throw error;
        onReachability(false);
        timer = setTimeout(fetchCode, UNREACHABLE_RETRY_MS);
      }
    };
    void fetchCode();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, onReachability]);

  useEffect(() => {
    if (!code) return undefined;
    let stopped = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const result = await pollPairing(code);
          if (stopped) return;
          onReachability(true);
          if (result.status === "paired") {
            stopped = true;
            clearInterval(id);
            onPaired(result.device_token);
          } else if (result.status === "expired") {
            setCode(null);
          }
        } catch (error) {
          if (!(error instanceof Unreachable)) throw error;
          if (!stopped) onReachability(false);
        }
      })();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [code, onPaired, onReachability]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (code && now >= deadline) setCode(null);
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
