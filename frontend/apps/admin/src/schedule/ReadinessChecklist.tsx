import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ReadinessItem, ReadinessKey } from "./readiness";

function fixLink(key: ReadinessKey, sessionId: number): string {
  switch (key) {
    case "gamePlugin":
      return "/events/setup";
    case "timezone":
      return "/sessions";
    case "playingTimes":
      return "#playing-times";
    case "teams":
      return `/sessions/${sessionId}/checkin`;
    case "fields":
      return `/sessions/${sessionId}/fields`;
  }
}

/** Only what still blocks scheduling, each with a link to fix it; nothing at all once it's all in place. */
export function ReadinessChecklist({ items, sessionId }: { items: ReadinessItem[]; sessionId: number }) {
  const { t } = useTranslation();
  const headingId = useId();
  const blockers = items.filter((item) => !item.ok);
  if (blockers.length === 0) return null;
  return (
    <section className="alert alert-warning readiness" aria-labelledby={headingId}>
      <strong id={headingId}>{t("sessions.schedule.readiness.heading")}</strong>
      <ul className="readiness__list">
        {blockers.map((item) => (
          <li key={item.key}>
            {t(`sessions.schedule.readiness.${item.key}`)}{" "}
            <Link to={fixLink(item.key, sessionId)}>{t(`sessions.schedule.readiness.${item.key}Fix`)}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
