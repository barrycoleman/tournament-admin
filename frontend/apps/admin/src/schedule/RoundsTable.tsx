import { useTranslation } from "react-i18next";
import { formatMatchTime, spansMultipleDays } from "../matchTime";
import { roundTypeLabel } from "../roundTypeLabel";
import {
  defaultMatchesPerTeam,
  formatCycle,
  isRowChanged,
  needsRebuild,
  newRow,
  splitCycle,
  type RoundRow,
} from "./planDraft";
import type { PlanResponse, ScheduledRound } from "../types";

interface RoundsTableProps {
  rows: RoundRow[];
  /** Keys of the rows the next Generate/Apply sends. */
  sendKeys: Set<string>;
  preview: PlanResponse | undefined;
  timeZone: string | null;
  availableTypes: string[];
  onRowsChange: (rows: RoundRow[]) => void;
  onClear: (round: ScheduledRound) => void;
  cycleFor: (previous?: RoundRow) => number;
  nextKey: () => string;
}

export function RoundsTable({
  rows,
  sendKeys,
  preview,
  timeZone,
  availableTypes,
  onRowsChange,
  onClear,
  cycleFor,
  nextKey,
}: RoundsTableProps) {
  const { t, i18n } = useTranslation();
  const used = new Set(rows.map((row) => row.roundType));
  const addable = availableTypes.filter((type) => !used.has(type));

  function update(key: string, patch: Partial<RoundRow>) {
    onRowsChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function when(start: string | null, end: string | null): string {
    if (!start) return "—";
    const from = formatMatchTime(start, timeZone, true, i18n.language);
    if (!end) return `${from} → ${t("sessions.schedule.rounds.doesNotFit")}`;
    return `${from} – ${formatMatchTime(end, timeZone, spansMultipleDays([start, end], timeZone), i18n.language)}`;
  }

  return (
    <>
      {rows.length === 0 ? (
        <p>{t("sessions.schedule.rounds.none")}</p>
      ) : (
        <table className="schedule-table rounds-table">
          <thead>
            <tr>
              <th>{t("sessions.schedule.rounds.columnRound")}</th>
              <th>{t("sessions.schedule.rounds.columnMatchesPerTeam")}</th>
              <th>{t("sessions.schedule.rounds.columnCycle")}</th>
              <th>{t("sessions.schedule.rounds.columnMatches")}</th>
              <th>{t("sessions.schedule.rounds.columnWhen")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const label = roundTypeLabel(t, row.roundType);
              const locked = row.scheduled?.locked ?? false;
              const changed = isRowChanged(row);
              const planned = sendKeys.has(row.key)
                ? preview?.rounds.find((round) => round.round_type === row.roundType)
                : undefined;
              const { minutes, seconds } = splitCycle(Number.isNaN(row.cycleSeconds) ? 0 : row.cycleSeconds);
              const matchesChanged = row.original !== null && row.matchesPerTeam !== row.original.matchesPerTeam;
              const cycleChanged = row.original !== null && row.cycleSeconds !== row.original.cycleSeconds;
              return (
                <tr key={row.key}>
                  <td>
                    {row.scheduled ? (
                      label
                    ) : (
                      <select
                        className="select"
                        aria-label={t("sessions.schedule.rounds.newRoundTypeLabel", { n: index + 1 })}
                        value={row.roundType}
                        onChange={(event) => update(row.key, { roundType: event.target.value })}
                      >
                        {[row.roundType, ...addable].map((type) => (
                          <option key={type} value={type}>
                            {roundTypeLabel(t, type)}
                          </option>
                        ))}
                      </select>
                    )}
                    {locked ? (
                      <span className="pill">
                        <span aria-hidden="true">🔒 </span>
                        {t("sessions.schedule.rounds.pillScored", { count: row.scheduled!.scored_count })}
                      </span>
                    ) : row.scheduled === null ? (
                      <span className="pill pill--new">{t("sessions.schedule.rounds.pillNew")}</span>
                    ) : changed ? (
                      <span className="pill pill--changed">{t("sessions.schedule.rounds.pillChanged")}</span>
                    ) : needsRebuild(row) ? (
                      <span className="pill pill--changed">{t("sessions.schedule.rounds.pillNeedsRebuild")}</span>
                    ) : (
                      <span className="pill">{t("sessions.schedule.rounds.pillScheduled")}</span>
                    )}
                  </td>
                  <td>
                    {locked ? (
                      row.matchesPerTeam
                    ) : (
                      <>
                        <input
                          className={`input schedule-form__number${matchesChanged ? " input--changed" : ""}`}
                          type="number"
                          min={1}
                          step={1}
                          aria-label={t("sessions.schedule.rounds.matchesPerTeamLabel", { round: label })}
                          value={Number.isNaN(row.matchesPerTeam) ? "" : row.matchesPerTeam}
                          onChange={(event) => update(row.key, { matchesPerTeam: event.target.valueAsNumber })}
                        />
                        {matchesChanged && (
                          <span className="rounds-table__hint">
                            {t("sessions.schedule.rounds.was", { value: row.original!.matchesPerTeam })}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {locked ? (
                      formatCycle(row.cycleSeconds)
                    ) : (
                      <span className="schedule-form__duration">
                        <input
                          className={`input schedule-form__number${cycleChanged ? " input--changed" : ""}`}
                          type="number"
                          min={0}
                          step={1}
                          aria-label={t("sessions.schedule.rounds.cycleMinutesLabel", { round: label })}
                          value={minutes}
                          onChange={(event) => update(row.key, { cycleSeconds: event.target.valueAsNumber * 60 + seconds })}
                        />
                        <span aria-hidden="true">{t("sessions.schedule.rounds.minutesUnit")}</span>
                        <input
                          className={`input schedule-form__number${cycleChanged ? " input--changed" : ""}`}
                          type="number"
                          min={0}
                          max={59}
                          step={1}
                          aria-label={t("sessions.schedule.rounds.cycleSecondsLabel", { round: label })}
                          value={seconds}
                          onChange={(event) => {
                            const value = event.target.valueAsNumber;
                            update(row.key, { cycleSeconds: value >= 0 && value <= 59 ? minutes * 60 + value : Number.NaN });
                          }}
                        />
                        <span aria-hidden="true">{t("sessions.schedule.rounds.secondsUnit")}</span>
                        {cycleChanged && (
                          <span className="rounds-table__hint">
                            {t("sessions.schedule.rounds.was", { value: formatCycle(row.original!.cycleSeconds) })}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td>{planned?.match_count ?? row.scheduled?.match_count ?? "—"}</td>
                  <td>
                    {planned
                      ? when(planned.first_start, planned.last_end)
                      : row.scheduled
                        ? when(row.scheduled.first_start, row.scheduled.last_end)
                        : index > 0
                          ? t("sessions.schedule.rounds.pending", { round: roundTypeLabel(t, rows[index - 1].roundType) })
                          : "—"}
                  </td>
                  <td>
                    {row.scheduled ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t("sessions.schedule.rounds.clearAriaLabel", { round: label })}
                        onClick={() => onClear(row.scheduled!)}
                      >
                        {t("sessions.schedule.rounds.clearAction")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t("sessions.schedule.rounds.removeLabel", { round: label })}
                        onClick={() => onRowsChange(rows.filter((other) => other.key !== row.key))}
                      >
                        {t("sessions.schedule.rounds.remove")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button
        type="button"
        className="btn btn-small schedule-form__add"
        disabled={addable.length === 0}
        onClick={() =>
          onRowsChange([
            ...rows,
            newRow(addable[0], defaultMatchesPerTeam(addable[0]), cycleFor(rows[rows.length - 1]), nextKey()),
          ])
        }
      >
        {t("sessions.schedule.rounds.add")}
      </button>
    </>
  );
}
