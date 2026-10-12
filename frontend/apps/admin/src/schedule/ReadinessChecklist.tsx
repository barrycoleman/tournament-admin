import { GAME_PLUGIN_SECTION_PATH } from "../gamePlugin/useGamePlugin";
import { useId, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ReadinessItem, ReadinessKey } from "./readiness";

function fixLink(key: ReadinessKey, sessionId: number): string {
  switch (key) {
    case "gamePlugin":
      return GAME_PLUGIN_SECTION_PATH;
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

function showPlayingTimes(event: MouseEvent<HTMLAnchorElement>) {
  const panel = document.getElementById("playing-times");
  if (!panel) return;
  event.preventDefault();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  panel.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
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
            {item.key === "playingTimes" ? (
              // A same-page target: client-side navigation wouldn't scroll to it.
              <a href="#playing-times" onClick={showPlayingTimes}>
                {t("sessions.schedule.readiness.playingTimesFix")}
              </a>
            ) : (
              <Link to={fixLink(item.key, sessionId)}>{t(`sessions.schedule.readiness.${item.key}Fix`)}</Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
