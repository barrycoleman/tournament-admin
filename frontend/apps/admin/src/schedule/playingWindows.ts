import type { PlayingWindowRead } from "../types";

export interface WindowDraft {
  date: string;
  startTime: string;
  endTime: string;
}

export type WindowDraftError = "incomplete" | "endBeforeStart" | "overlap";

export function draftsFromWindows(windows: PlayingWindowRead[]): WindowDraft[] {
  return windows.map((w) => ({ date: w.date, startTime: w.start_time, endTime: w.end_time }));
}

function sorted(drafts: WindowDraft[]): WindowDraft[] {
  return [...drafts].sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
}

/** Mirrors the server's checks so most mistakes show before Save. */
export function validateWindowDrafts(drafts: WindowDraft[]): WindowDraftError | null {
  if (drafts.some((d) => !d.date || !d.startTime || !d.endTime)) return "incomplete";
  if (drafts.some((d) => d.endTime <= d.startTime)) return "endBeforeStart";
  const ordered = sorted(drafts);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].date === ordered[i - 1].date && ordered[i].startTime < ordered[i - 1].endTime) return "overlap";
  }
  return null;
}

export function windowsPayload(drafts: WindowDraft[]) {
  return {
    windows: sorted(drafts).map((d) => ({ date: d.date, start_time: d.startTime, end_time: d.endTime })),
  };
}

export function nextWindowDraft(drafts: WindowDraft[], sessionDate: string | null, today: string): WindowDraft {
  const last = sorted(drafts).at(-1);
  if (!last) return { date: sessionDate ?? today, startTime: "09:00", endTime: "12:00" };
  return { date: last.date, startTime: last.endTime, endTime: "" };
}

/** A calendar date's short weekday; the date has no zone, so it is read as UTC noon. */
export function weekdayLabel(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function summarizeWindows(
  windows: Pick<PlayingWindowRead, "date" | "start_time" | "end_time">[],
  locale: string
): string {
  const byDate = new Map<string, string[]>();
  for (const w of windows) byDate.set(w.date, [...(byDate.get(w.date) ?? []), `${w.start_time}–${w.end_time}`]);
  return [...byDate.entries()].map(([date, ranges]) => `${weekdayLabel(date, locale)} ${ranges.join(", ")}`).join(" · ");
}

/** The PUT body that moves only the last window's end. */
export function withLastWindowEnd(windows: PlayingWindowRead[], endTime: string) {
  return {
    windows: windows.map((w, index) => ({
      date: w.date,
      start_time: w.start_time,
      end_time: index === windows.length - 1 ? endTime : w.end_time,
    })),
  };
}

export function todayInZone(timeZone: string | null, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
