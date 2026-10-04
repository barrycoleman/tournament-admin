import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "./formatDuration";
import { weekdayLabel } from "./playingWindows";
import { overflowSegment, segmentsInWindow, type TimelineSpan } from "./timeline";
import type { PlayingWindowRead } from "../types";

/** One bar per playing window, sized by its length, with each round drawn where it runs. */
export function PlanTimeline({
  windows,
  spans,
  overBySeconds,
}: {
  windows: PlayingWindowRead[];
  spans: TimelineSpan[];
  overBySeconds: number;
}) {
  const { t, i18n } = useTranslation();
  const usable = windows.filter((w) => w.start_utc !== null && w.end_utc !== null);
  if (usable.length === 0) return null;
  return (
    <div className="plan-timeline">
      {usable.map((window, index) => {
        const startMs = Date.parse(window.start_utc!);
        const endMs = Date.parse(window.end_utc!);
        const segments = segmentsInWindow(startMs, endMs, spans);
        if (overBySeconds > 0 && index === usable.length - 1) segments.push(overflowSegment(startMs, endMs, overBySeconds));
        const previous = usable[index - 1];
        return (
          <Fragment key={`${window.date}-${window.start_time}`}>
            {previous && (
              <span className="plan-timeline__gap">
                {previous.date === window.date
                  ? t("sessions.schedule.playingTimes.gapBreak", {
                      duration: formatDuration(t, (startMs - Date.parse(previous.end_utc!)) / 1000),
                    })
                  : t("sessions.schedule.playingTimes.gapOvernight")}
              </span>
            )}
            <div className="plan-timeline__window" style={{ flexGrow: (endMs - startMs) / 60_000 }}>
              <div className="plan-timeline__bar" aria-hidden="true">
                {segments.map((segment, i) => (
                  <span
                    key={i}
                    className={`plan-timeline__segment plan-timeline__segment--${segment.kind}`}
                    data-round={segment.roundType}
                    style={{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }}
                  />
                ))}
              </div>
              <span className="plan-timeline__label">
                {weekdayLabel(window.date, i18n.language)} {window.start_time}–{window.end_time}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
