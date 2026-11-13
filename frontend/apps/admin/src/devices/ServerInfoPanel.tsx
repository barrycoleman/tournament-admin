import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { apiRequest } from "@tournament-admin/shared";
import type { ServerInfo } from "../types";

/** The addresses a device on this network can open, each with a QR code. */
export function ServerInfoPanel() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["server-info"],
    queryFn: () => apiRequest<ServerInfo>("/api/server-info"),
  });
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});

  useEffect(() => {
    if (!data) return;
    for (const address of data.addresses) {
      const canvas = canvasRefs.current[address];
      if (canvas) {
        void QRCode.toCanvas(canvas, `http://${address}:${data.port}`);
      }
    }
  }, [data]);

  if (!data) return null;

  return (
    <section className="panel">
      <h2>{t("devicesDisplays.serverInfoHeading")}</h2>
      <div className="server-info-grid">
        {data.addresses.map((address) => (
          <div className="server-info-card" key={address}>
            <canvas
              ref={(node) => {
                canvasRefs.current[address] = node;
              }}
            />
            <p>
              {t("devicesDisplays.serverInfoAddressLabel")}: {address}:{data.port}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
