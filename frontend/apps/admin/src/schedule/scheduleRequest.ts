import type { ResolvedTimeBlock } from "../types";

export type TimingMode = "fit" | "fixed";

export interface PhaseDraft {
  roundType: string;
  matchesPerTeam: number;
}

/** `endTime: ""` means left blank. */
export interface BlockDraft {
  date: string;
  startTime: string;
  endTime: string;
}

export interface ScheduleFormState {
  schedulerPluginName: string;
  phases: PhaseDraft[];
  timingMode: TimingMode;
  cycleMinutes: number;
  blocks: BlockDraft[];
}

export interface ScheduleRequestPayload {
  session_id: number;
  division_id?: number;
  scheduler_plugin_name: string;
  phases: { round_type: string; target_matches_per_team: number }[];
  time_blocks: { date: string; start_time: string; end_time: string | null; cycle_time: number | null }[];
  dry_run: boolean;
}

export type BuildResult = { ok: true; payload: ScheduleRequestPayload } | { ok: false; errorKey: string };

const ERRORS = "sessions.schedule.form.errors";

function fail(name: string): BuildResult {
  return { ok: false, errorKey: `${ERRORS}.${name}` };
}

/**
 * Turns the form into a `POST /api/schedule` body. "fit" sends every block
 * with an end time and `cycle_time: null` (the server computes cycle time);
 * "fixed" sends one cycle time on every block and lets only the last block
 * leave its end time blank (open-ended). The backend forbids mixing those
 * two kinds of block, which is why the mode is form-wide.
 */
export function buildScheduleRequest(
  state: ScheduleFormState,
  { sessionId, divisionId, dryRun }: { sessionId: number; divisionId: number | null; dryRun: boolean }
): BuildResult {
  if (!state.schedulerPluginName) return fail("noScheduler");
  if (state.phases.length === 0) return fail("noPhases");
  if (state.phases.some((p) => !p.roundType || !Number.isInteger(p.matchesPerTeam) || p.matchesPerTeam < 1)) {
    return fail("invalidPhase");
  }
  if (state.blocks.length === 0) return fail("noBlocks");
  if (state.blocks.some((b) => !b.date || !b.startTime)) return fail("blockIncomplete");

  const sorted = [...state.blocks].sort((a, b) =>
    `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`)
  );
  let cycleSeconds: number | null = null;
  if (state.timingMode === "fit") {
    if (sorted.some((b) => !b.endTime)) return fail("endTimeRequired");
  } else {
    if (!(state.cycleMinutes > 0)) return fail("cycleRequired");
    if (sorted.slice(0, -1).some((b) => !b.endTime)) return fail("endTimeRequiredExceptLast");
    cycleSeconds = Math.round(state.cycleMinutes * 60);
  }

  const payload: ScheduleRequestPayload = {
    session_id: sessionId,
    scheduler_plugin_name: state.schedulerPluginName,
    phases: state.phases.map((p) => ({ round_type: p.roundType, target_matches_per_team: p.matchesPerTeam })),
    time_blocks: sorted.map((b) => ({
      date: b.date,
      start_time: b.startTime,
      end_time: b.endTime || null,
      cycle_time: cycleSeconds,
    })),
    dry_run: dryRun,
  };
  if (divisionId !== null) payload.division_id = divisionId;
  return { ok: true, payload };
}

export function availableRoundTypes(all: string[], existing: string[]): string[] {
  return all.filter((roundType) => !existing.includes(roundType));
}

export function defaultPhases(available: string[]): PhaseDraft[] {
  const phases: PhaseDraft[] = [];
  if (available.includes("practice")) phases.push({ roundType: "practice", matchesPerTeam: 1 });
  if (available.includes("qualification")) phases.push({ roundType: "qualification", matchesPerTeam: 6 });
  if (phases.length === 0 && available.length > 0) phases.push({ roundType: available[0], matchesPerTeam: 1 });
  return phases;
}

export function roundTypeOptionsForRow(available: string[], phases: PhaseDraft[], rowIndex: number): string[] {
  const takenElsewhere = phases.filter((_, index) => index !== rowIndex).map((p) => p.roundType);
  return available.filter((roundType) => !takenElsewhere.includes(roundType));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Wall-clock finish (`start + slots x cycle`) of a block, with how many days it rolled past midnight. */
export function projectedFinish(
  block: Pick<ResolvedTimeBlock, "start_time" | "time_slot_count" | "cycle_time_seconds">
): { time: string; dayOffset: number } {
  const [hours, minutes] = block.start_time.split(":").map(Number);
  const total = hours * 60 + minutes + Math.round((block.time_slot_count * block.cycle_time_seconds) / 60);
  const minuteOfDay = total % 1440;
  return {
    time: `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`,
    dayOffset: Math.floor(total / 1440),
  };
}

export function formatCycleTime(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** Mirrors the server's default `warn_below_multiplier` of 1.5. */
export function isCycleTimeTight(cycleMinutes: number, matchDurationSeconds: number): boolean {
  return cycleMinutes > 0 && cycleMinutes * 60 < matchDurationSeconds * 1.5;
}

export function todayInZone(timeZone: string | null, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
