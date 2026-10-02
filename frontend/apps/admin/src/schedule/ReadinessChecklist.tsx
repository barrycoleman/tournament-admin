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
    case "teams":
      return `/sessions/${sessionId}/checkin`;
    case "fields":
      return `/sessions/${sessionId}/fields`;
  }
}

export function ReadinessChecklist({ items, sessionId }: { items: ReadinessItem[]; sessionId: number }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.readiness.heading")}</h2>
      <ul className="list-plain">
        {items.map((item) => (
          <li key={item.key} className="list-row readiness-item">
            <span className={item.ok ? "badge badge-success" : "badge badge-warning"}>
              {item.ok ? t("sessions.schedule.readiness.ok") : t("sessions.schedule.readiness.missing")}
            </span>
            <span>{t(`sessions.schedule.readiness.${item.key}`)}</span>
            {!item.ok && (
              <Link to={fixLink(item.key, sessionId)}>{t(`sessions.schedule.readiness.${item.key}Fix`)}</Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
