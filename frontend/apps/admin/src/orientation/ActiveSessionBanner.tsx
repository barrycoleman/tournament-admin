import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { formatMatchTime } from "../matchTime";
import { useMakeActive } from "./MakeActiveDialog";
import { cutoverOffer, dateInZone, hasPlayingTimes, sessionZone } from "./sessionTime";
import { isBannerSnoozed, snoozeBanner } from "./snooze";
import { useNow } from "./useNow";
import { browserZone, useEvent, useSessions, useSessionWindows } from "./useOrientationData";

const TICK_MS = 30_000;

/** A YYYY-MM-DD as a short weekday and date, e.g. "Sun, Oct 25". */
function formatDay(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Offers to make the next session active once its cutover time has passed. */
export function ActiveSessionBanner() {
  const { t, i18n } = useTranslation();
  const now = useNow(TICK_MS);
  // Bumped by "Not yet" so the snooze takes effect without waiting for a tick.
  const [, setSnoozedAt] = useState(0);
  const event = useEvent();
  const sessions = useSessions();
  const sessionList = sessions.data ?? [];
  const windows = useSessionWindows(sessionList.map((s) => s.id));
  const makeActive = useMakeActive();

  const fallbackZone = browserZone();
  const offer =
    event.data && sessions.data && !windows.isLoading
      ? cutoverOffer({
          sessions: sessionList,
          windowsById: windows.windowsById,
          activeId: event.data.active_session_id,
          now,
          fallbackZone,
        })
      : null;
  const session = offer ? sessionList.find((s) => s.id === offer.sessionId) : undefined;
  const visible = offer && session && !isBannerSnoozed(session.id, now);
  const zone = session ? sessionZone(session, fallbackZone) : fallbackZone;
  // Name the day too when the session doesn't start today in its own zone.
  const startsToday = offer ? dateInZone(offer.startsAt, zone) === dateInZone(now, zone) : true;
  // Without playing times the span is the whole day, so its "start" is a misleading 00:00.
  const timed = session ? hasPlayingTimes(windows.windowsById[session.id] ?? []) : true;
  const messageKey = timed
    ? "orientation.banner.message"
    : startsToday
      ? "orientation.banner.messageToday"
      : "orientation.banner.messageDate";
  const day = offer ? dateInZone(offer.startsAt, zone) : "";

  return (
    <>
      {visible && (
        <div className="alert alert-warning active-session-banner" role="status">
          <p>
            <Trans
              t={t}
              i18nKey={messageKey}
              values={{
                label: session.label,
                time: timed ? formatMatchTime(offer.startsAt.toISOString(), zone, !startsToday, i18n.language) : "",
                date: timed ? "" : formatDay(day, i18n.language),
              }}
              components={{ strong: <strong /> }}
            />
          </p>
          <div className="active-session-banner__actions">
            <button type="button" className="btn btn-primary btn-small" onClick={() => makeActive.open(session)}>
              {t("orientation.banner.makeActiveAction")}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                const at = new Date();
                snoozeBanner(session.id, at);
                setSnoozedAt(at.getTime());
              }}
            >
              {t("orientation.banner.notYetAction")}
            </button>
          </div>
        </div>
      )}
      {makeActive.dialog}
    </>
  );
}
