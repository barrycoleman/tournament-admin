import type { ScheduledRound } from "../types";

/** One row of a division's plan: a scheduled round or one added in this draft. */
export interface RoundRow {
  /** The round type for a scheduled round; a `new-…` key for a row added in this draft. */
  key: string;
  roundType: string;
  matchesPerTeam: number;
  cycleSeconds: number;
  /** The server's round, or null for a new row. */
  scheduled: ScheduledRound | null;
  /** The values the row started from, to tell an edit from no change; null for a new row. */
  original: { matchesPerTeam: number; cycleSeconds: number } | null;
}

export interface PlanRequest {
  session_id: number;
  division_id?: number;
  scheduler_plugin_name: string;
  rounds: { round_type: string; target_matches_per_team: number; cycle_time_seconds: number }[];
  dry_run: boolean;
}

/** Elimination matches come from the finals bracket, never the planner. */
export function plannerRoundTypes(all: string[]): string[] {
  return all.filter((roundType) => roundType !== "elimination");
}

export function fallbackCycleSeconds(matchSeconds: number): number {
  return Math.ceil((matchSeconds + 120) / 60) * 60;
}

export function defaultCycleSeconds({
  previousRow,
  sessionLast,
  pluginDefault,
  matchSeconds,
}: {
  previousRow?: RoundRow;
  sessionLast: number | null;
  pluginDefault: number | null;
  matchSeconds: number;
}): number {
  return previousRow?.cycleSeconds ?? sessionLast ?? pluginDefault ?? fallbackCycleSeconds(matchSeconds);
}

export function defaultMatchesPerTeam(roundType: string): number {
  return roundType === "practice" ? 1 : 6;
}

export function newRow(roundType: string, matchesPerTeam: number, cycleSeconds: number, key: string): RoundRow {
  return { key, roundType, matchesPerTeam, cycleSeconds, scheduled: null, original: null };
}

function rowFromServer(round: ScheduledRound, fallbackCycle: number): RoundRow {
  const matchesPerTeam = round.target_matches_per_team ?? 1;
  const cycleSeconds = round.cycle_time_seconds ?? fallbackCycle;
  return {
    key: round.round_type,
    roundType: round.round_type,
    matchesPerTeam,
    cycleSeconds,
    scheduled: round,
    original: { matchesPerTeam, cycleSeconds },
  };
}

/**
 * A division's rows when it first loads: its scheduled rounds or, when
 * nothing is scheduled yet, a suggested new row per planner round type.
 */
export function initialRows(
  rounds: ScheduledRound[],
  available: string[],
  cycleFor: (previous?: RoundRow) => number
): RoundRow[] {
  if (rounds.length > 0) return rounds.map((round) => rowFromServer(round, cycleFor()));
  const rows: RoundRow[] = [];
  available.forEach((roundType, index) => {
    rows.push(newRow(roundType, defaultMatchesPerTeam(roundType), cycleFor(rows[rows.length - 1]), `new-${index}`));
  });
  return rows;
}

export function isRowChanged(row: RoundRow): boolean {
  return (
    row.original !== null &&
    (row.matchesPerTeam !== row.original.matchesPerTeam || row.cycleSeconds !== row.original.cycleSeconds)
  );
}

export function needsRebuild(row: RoundRow): boolean {
  return Boolean(row.scheduled?.outside_playing_windows && !row.scheduled.locked);
}

/** The first row that is new, changed or needs a rebuild, and every row after it. */
export function rowsToSend(rows: RoundRow[]): RoundRow[] {
  const first = rows.findIndex((row) => row.scheduled === null || isRowChanged(row) || needsRebuild(row));
  return first === -1 ? [] : rows.slice(first);
}

export function planAction(rows: RoundRow[]): "none" | "generate" | "apply" {
  const toSend = rowsToSend(rows);
  if (toSend.length === 0) return "none";
  return toSend.some((row) => row.scheduled !== null) ? "apply" : "generate";
}

export function rowsValid(rows: RoundRow[], matchSeconds: number): boolean {
  return rows.every(
    (row) =>
      Number.isInteger(row.matchesPerTeam) &&
      row.matchesPerTeam >= 1 &&
      Number.isInteger(row.cycleSeconds) &&
      row.cycleSeconds >= matchSeconds
  );
}

export function buildPlanRequest(
  rows: RoundRow[],
  {
    sessionId,
    divisionId,
    schedulerPluginName,
    dryRun,
  }: { sessionId: number; divisionId: number | null; schedulerPluginName: string; dryRun: boolean }
): PlanRequest {
  const request: PlanRequest = {
    session_id: sessionId,
    scheduler_plugin_name: schedulerPluginName,
    rounds: rows.map((row) => ({
      round_type: row.roundType,
      target_matches_per_team: row.matchesPerTeam,
      cycle_time_seconds: row.cycleSeconds,
    })),
    dry_run: dryRun,
  };
  if (divisionId !== null) request.division_id = divisionId;
  return request;
}

/**
 * Folds a refresh of the server's rounds into the draft: unlocked rows keep
 * this admin's edits, rows that became locked go back to the server's
 * values (their round types are returned in `dropped`), and new rows stay
 * unless their round is now scheduled.
 */
export function mergeServerRounds(
  rows: RoundRow[],
  rounds: ScheduledRound[],
  fallbackCycle: number
): { rows: RoundRow[]; dropped: string[] } {
  const dropped: string[] = [];
  const merged = rounds.map((round) => {
    const fresh = rowFromServer(round, fallbackCycle);
    const current = rows.find((row) => row.scheduled !== null && row.key === round.round_type);
    if (!current) return fresh;
    if (round.locked) {
      if (isRowChanged(current)) dropped.push(round.round_type);
      return fresh;
    }
    if (!isRowChanged(current)) return fresh;
    return { ...current, scheduled: round, original: fresh.original };
  });
  const scheduledTypes = new Set(rounds.map((round) => round.round_type));
  const pendingNew = rows.filter((row) => row.scheduled === null && !scheduledTypes.has(row.roundType));
  return { rows: [...merged, ...pendingNew], dropped };
}

export function splitCycle(seconds: number): { minutes: number; seconds: number } {
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}

export function formatCycle(seconds: number): string {
  const { minutes, seconds: rest } = splitCycle(Math.round(seconds));
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
