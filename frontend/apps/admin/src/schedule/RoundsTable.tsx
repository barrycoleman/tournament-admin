import { useState } from "react";
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

  // What each row will hold: the dry run's answer for rows being sent, else what's scheduled.
  const outcomes = rows.map((row) => {
    if (!sendKeys.has(row.key)) return row.scheduled;
    return preview?.rounds.find((round) => round.round_type === row.roundType) ?? null;
  });
  const finish = outcomes.at(-1)?.last_end ?? null;
  const total =
    rows.length > 0 && finish && outcomes.every((outcome) => outcome !== null)
      ? outcomes.reduce((sum, outcome) => sum + outcome!.match_count, 0)
      : null;
  const times = outcomes.flatMap((outcome) => [outcome?.first_start, outcome?.last_end]).filter(Boolean) as string[];

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
              const matchesChanged = row.original !== null && row.matchesPerTeam !== row.original.matchesPerTeam;
              const cycleChanged = row.original !== null && !Object.is(row.cycleSeconds, row.original.cycleSeconds);
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
                      <CycleInputs
                        cycleSeconds={row.cycleSeconds}
                        round={label}
                        original={cycleChanged ? row.original!.cycleSeconds : null}
                        onChange={(cycleSeconds) => update(row.key, { cycleSeconds })}
                      />
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
      {total !== null && (
        <p className="rounds-table__total">
          {t("sessions.schedule.rounds.total", {
            count: total,
            time: formatMatchTime(finish!, timeZone, spansMultipleDays(times, timeZone), i18n.language),
          })}
        </p>
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

/** Whole minutes and seconds (0–59) make a cycle time; anything else is NaN. */
function parseCycle(minutes: string, seconds: string): number {
  if (!/^\d+$/.test(minutes) || !/^\d+$/.test(seconds)) return Number.NaN;
  const rest = Number(seconds);
  return rest > 59 ? Number.NaN : Number(minutes) * 60 + rest;
}

function cycleText(cycleSeconds: number): { minutes: string; seconds: string } {
  if (Number.isNaN(cycleSeconds)) return { minutes: "", seconds: "" };
  const { minutes, seconds } = splitCycle(cycleSeconds);
  return { minutes: String(minutes), seconds: String(seconds) };
}

interface CycleInputsProps {
  cycleSeconds: number;
  round: string;
  /** The scheduled cycle time when this one differs from it, else null. */
  original: number | null;
  onChange: (cycleSeconds: number) => void;
}

/** Minutes and seconds inputs that show exactly what was typed, even while it isn't a valid cycle time. */
function CycleInputs({ cycleSeconds, round, original, onChange }: CycleInputsProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => cycleText(cycleSeconds));
  const [seen, setSeen] = useState(cycleSeconds);
  // Follow a change made elsewhere (a suggested cycle time, Discard, a server refresh).
  if (!Object.is(seen, cycleSeconds)) {
    setSeen(cycleSeconds);
    if (!Object.is(parseCycle(text.minutes, text.seconds), cycleSeconds)) setText(cycleText(cycleSeconds));
  }
  const changedClass = original !== null ? " input--changed" : "";

  function edit(next: { minutes: string; seconds: string }) {
    setText(next);
    onChange(parseCycle(next.minutes, next.seconds));
  }

  return (
    <span className="schedule-form__duration">
      <input
        className={`input schedule-form__number${changedClass}`}
        type="number"
        min={0}
        step={1}
        aria-label={t("sessions.schedule.rounds.cycleMinutesLabel", { round })}
        value={text.minutes}
        onChange={(event) => edit({ ...text, minutes: event.target.value })}
      />
      <span aria-hidden="true">{t("sessions.schedule.rounds.minutesUnit")}</span>
      <input
        className={`input schedule-form__number${changedClass}`}
        type="number"
        min={0}
        max={59}
        step={1}
        aria-label={t("sessions.schedule.rounds.cycleSecondsLabel", { round })}
        value={text.seconds}
        onChange={(event) => edit({ ...text, seconds: event.target.value })}
      />
      <span aria-hidden="true">{t("sessions.schedule.rounds.secondsUnit")}</span>
      {original !== null && (
        <span className="rounds-table__hint">{t("sessions.schedule.rounds.was", { value: formatCycle(original) })}</span>
      )}
    </span>
  );
}
