import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { roundTypeLabel } from "../roundTypeLabel";
import { formatDuration } from "./formatDuration";
import { formatCycle } from "./planDraft";
import { weekdayLabel } from "./playingWindows";
import type { PlanPreview } from "./usePlanPreview";
import type { PlayingWindowRead } from "../types";

interface FitStatusProps {
  preview: PlanPreview;
  windows: PlayingWindowRead[];
  onUseCycle: (seconds: number) => void;
  onExtend: (endTime: string) => void;
  extendPending: boolean;
}

/** Whether the draft fits the playing times and, when it doesn't, the two one-click fixes. */
export function FitStatus({ preview, windows, onUseCycle, onExtend, extendPending }: FitStatusProps) {
  const { t, i18n } = useTranslation();
  if (preview.error) {
    return (
      <p className="alert alert-danger fit-status" role="alert">
        {apiErrorMessage(preview.error, t("errors.generic"))}
      </p>
    );
  }
  const data = preview.data;
  if (!data) {
    return (
      <p className="fit-status" role="status">
        {t("sessions.schedule.fit.checking")}
      </p>
    );
  }
  const stale = preview.settled ? "" : " fit-status--stale";
  if (data.fits) {
    const lastEnd = data.rounds.at(-1)?.last_end;
    const lastEndMs = lastEnd ? Date.parse(lastEnd) : Number.NaN;
    const window = windows.find(
      (w) => w.start_utc && w.end_utc && Date.parse(w.start_utc) <= lastEndMs && lastEndMs <= Date.parse(w.end_utc)
    );
    const freeSeconds = window && lastEnd ? (Date.parse(window.end_utc!) - Date.parse(lastEnd)) / 1000 : 0;
    return (
      <p className={`fit-status fit-status--ok${stale}`} role="status">
        {"✓ "}
        {window && freeSeconds >= 60
          ? t("sessions.schedule.fit.fits", {
              free: formatDuration(t, freeSeconds),
              day: weekdayLabel(window.date, i18n.language),
            })
          : t("sessions.schedule.fit.fitsExactly")}
      </p>
    );
  }
  const overflow = data.overflow!;
  const firstShort = data.rounds.find((round) => round.last_end === null) ?? data.rounds.at(-1)!;
  const last = windows.at(-1)!;
  const day = weekdayLabel(last.date, i18n.language);
  return (
    <div className={`alert alert-warning fit-status${stale}`} role="status">
      <p>
        {"⚠ "}
        {t("sessions.schedule.fit.over", {
          duration: formatDuration(t, overflow.over_by_seconds),
          count: overflow.unplaced_match_count,
          round: roundTypeLabel(t, firstShort.round_type),
          end: `${day} ${last.end_time}`,
        })}
      </p>
      <div className="form-actions">
        {overflow.suggested_cycle_time_seconds !== null && (
          <button
            type="button"
            className="btn btn-small"
            disabled={!preview.settled}
            onClick={() => onUseCycle(overflow.suggested_cycle_time_seconds!)}
          >
            {t("sessions.schedule.fit.useCycle", { cycle: formatCycle(overflow.suggested_cycle_time_seconds) })}
          </button>
        )}
        {overflow.suggested_last_window_end !== null && (
          <button
            type="button"
            className="btn btn-small"
            disabled={extendPending || !preview.settled}
            onClick={() => onExtend(overflow.suggested_last_window_end!)}
          >
            {t("sessions.schedule.fit.extend", { day, time: overflow.suggested_last_window_end })}
          </button>
        )}
      </div>
    </div>
  );
}
