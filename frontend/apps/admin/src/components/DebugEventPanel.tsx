import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";

const MAX_EVENTS = 50;

interface LoggedEvent {
  receivedAt: string;
  event: RealtimeEvent;
}

export function DebugEventPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<LoggedEvent[]>([]);

  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      setEvents((prev) =>
        [...prev, { receivedAt: new Date().toISOString(), event }].slice(-MAX_EVENTS)
      );
    },
  });

  return (
    <section className="debug-panel">
      <button className="btn btn-small" onClick={() => setOpen((prev) => !prev)}>
        {t("debugPanel.toggle")} ({events.length})
      </button>
      {open && (
        <div className="debug-panel__body">
          {events.length === 0 ? (
            <p>{t("debugPanel.empty")}</p>
          ) : (
            <ul className="list-plain">
              {events.map((entry, index) => (
                <li key={index} className="debug-panel__entry">
                  <time>{entry.receivedAt}</time>
                  <pre>{JSON.stringify(entry.event, null, 2)}</pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
