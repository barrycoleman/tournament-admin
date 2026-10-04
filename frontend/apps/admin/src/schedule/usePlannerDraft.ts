import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultCycleSeconds,
  initialRows,
  isDraftDirty,
  mergeServerRounds,
  plannerRoundTypes,
  pruneScheduledRows,
  type RoundRow,
} from "./planDraft";
import type { MatchFormat, ScheduleRounds } from "../types";

/** A division's editable rows, rebuilt from the server's rounds whenever they refresh. */
export function usePlannerDraft(scheduled: ScheduleRounds | undefined, matchFormat: MatchFormat) {
  const [rows, setRows] = useState<RoundRow[] | null>(null);
  /** The new rows the draft started with, so untouched suggestions don't count as unsaved work. */
  const [baselineNew, setBaselineNew] = useState<RoundRow[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const nextKey = useRef(1000);

  const cycleFor = useCallback(
    (previous?: RoundRow) =>
      defaultCycleSeconds({
        previousRow: previous,
        sessionLast: scheduled?.session_last_cycle_time_seconds ?? null,
        pluginDefault: matchFormat.default_cycle_time_seconds,
        matchSeconds: matchFormat.match_duration_seconds,
      }),
    [scheduled, matchFormat]
  );

  const reset = (from: ScheduleRounds) => {
    const fresh = initialRows(from.rounds, plannerRoundTypes(matchFormat.round_types), cycleFor);
    setRows(fresh);
    setBaselineNew(fresh.filter((row) => row.scheduled === null));
  };

  useEffect(() => {
    if (!scheduled) return;
    if (rows === null) {
      reset(scheduled);
      return;
    }
    const merged = mergeServerRounds(rows, scheduled.rounds, cycleFor());
    setRows(merged.rows);
    setBaselineNew((baseline) => pruneScheduledRows(baseline, scheduled.rounds));
    if (merged.dropped.length > 0) setDropped(merged.dropped);
    // Re-merge only when the server's rounds change, never on a local edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled]);

  return {
    rows: rows ?? [],
    loaded: rows !== null,
    dirty: rows !== null && isDraftDirty(rows, baselineNew),
    setRows,
    dropped,
    cycleFor,
    nextKey: () => `new-${nextKey.current++}`,
    discard: () => {
      if (scheduled) reset(scheduled);
    },
  };
}
