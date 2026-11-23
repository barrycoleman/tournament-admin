import { useTranslation } from "react-i18next";
import { formatOffset, startBand } from "@tournament-admin/shared";

/** The time to a match's scheduled start: green, then yellow from 30 s, red once late. */
export function StartCountdown({ scheduledTime, now }: { scheduledTime: string | null; now: number }) {
  const { t } = useTranslation();
  if (scheduledTime === null) {
    return (
      <p className="start start--next" data-testid="start" data-band="next">
        {t("display.upNext")}
      </p>
    );
  }
  const ms = Date.parse(scheduledTime) - now;
  const band = startBand(ms);
  return (
    <p className={`start start--${band}`} data-testid="start" data-band={band}>
      <span className="start__label">{band === "late" ? t("display.lateLabel") : t("display.startsInLabel")}</span>
      <span className="start__time">{formatOffset(ms)}</span>
    </p>
  );
}
