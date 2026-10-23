import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useMakeActive } from "./MakeActiveDialog";
import { cutoverOffer } from "./sessionTime";
import { isBannerSnoozed, snoozeBanner } from "./snooze";
import { useNow } from "./useNow";
import { browserZone, useEvent, useSessions, useSessionWindows } from "./useOrientationData";

const TICK_MS = 30_000;

/** Offers to make the next session active once its cutover time has passed. */
export function ActiveSessionBanner() {
  const { t } = useTranslation();
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

  return (
    <>
      {visible && (
        <div className="alert alert-warning active-session-banner" role="status">
          <p>
            <Trans
              t={t}
              i18nKey="orientation.banner.message"
              values={{
                label: session.label,
                time: new Intl.DateTimeFormat(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: session.timezone || fallbackZone,
                }).format(offer.startsAt),
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
