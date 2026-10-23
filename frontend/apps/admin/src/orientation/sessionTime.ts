import type { PlayingWindowRead, SessionRead } from "../types";

export interface SessionSpan {
  start: Date;
  end: Date;
}

export interface CutoverOffer {
  sessionId: number;
  startsAt: Date;
}

interface LandingInput {
  sessions: SessionRead[];
  windowsById: Record<number, PlayingWindowRead[]>;
  activeId: number | null;
  now: Date;
  fallbackZone: string;
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The session's own timezone, or `fallbackZone` when it has none or it isn't a zone `Intl` knows. */
export function sessionZone(session: SessionRead, fallbackZone: string): string {
  return session.timezone && isValidZone(session.timezone) ? session.timezone : fallbackZone;
}


/** Offset in ms of `zone` from UTC at the given instant. */
function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of 00:00 on the given YYYY-MM-DD in `zone`. */
function startOfDayUtc(date: string, zone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d);
  let guess = wallAsUtc - zoneOffsetMs(wallAsUtc, zone);
  guess = wallAsUtc - zoneOffsetMs(guess, zone);
  return new Date(guess);
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function dateInZone(now: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
}

export function sessionSpan(
  session: SessionRead,
  windows: PlayingWindowRead[],
  fallbackZone: string,
): SessionSpan | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const w of windows) {
    if (!w.start_utc || !w.end_utc) continue;
    const s = Date.parse(w.start_utc);
    const e = Date.parse(w.end_utc);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    if (start === null || s < start) start = s;
    if (end === null || e > end) end = e;
  }
  if (start !== null && end !== null) return { start: new Date(start), end: new Date(end) };
  if (session.session_date) {
    const zone = sessionZone(session, fallbackZone);
    return {
      start: startOfDayUtc(session.session_date, zone),
      end: startOfDayUtc(nextDay(session.session_date), zone),
    };
  }
  return null;
}

export function orderSessions(sessions: SessionRead[]): SessionRead[] {
  return [...sessions].sort((a, b) => {
    if (a.session_date && b.session_date) {
      if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
    } else if (a.session_date) {
      return -1;
    } else if (b.session_date) {
      return 1;
    }
    return a.id - b.id;
  });
}

export function isSessionToday(
  session: SessionRead,
  windows: PlayingWindowRead[],
  now: Date,
  fallbackZone: string,
): boolean {
  const today = dateInZone(now, sessionZone(session, fallbackZone));
  return session.session_date === today || windows.some((w) => w.date === today);
}

export function pickLandingSession(input: LandingInput): number | null {
  const { windowsById, activeId, now, fallbackZone } = input;
  const ordered = orderSessions(input.sessions);
  if (ordered.length === 0) return null;
  const windowsOf = (s: SessionRead) => windowsById[s.id] ?? [];
  const spanOf = (s: SessionRead) => sessionSpan(s, windowsOf(s), fallbackZone);
  const nowMs = now.getTime();

  const today = ordered.filter((s) => isSessionToday(s, windowsOf(s), now, fallbackZone));
  if (today.length > 0) {
    const active = today.find((s) => s.id === activeId);
    if (active) return active.id;
    const running = today.find((s) => {
      const span = spanOf(s);
      return span !== null && span.start.getTime() <= nowMs && nowMs < span.end.getTime();
    });
    return (running ?? today[0]).id;
  }

  const active = ordered.find((s) => s.id === activeId);
  if (active) return active.id;

  const spans = ordered.flatMap((s) => {
    const span = spanOf(s);
    return span ? [{ s, span }] : [];
  });
  let upcoming: { s: SessionRead; span: SessionSpan } | null = null;
  for (const x of spans) {
    if (x.span.start.getTime() >= nowMs && (!upcoming || x.span.start < upcoming.span.start)) upcoming = x;
  }
  if (upcoming) return upcoming.s.id;

  let latest: { s: SessionRead; span: SessionSpan } | null = null;
  for (const x of spans) {
    if (!latest || x.span.end > latest.span.end) latest = x;
  }
  if (latest) return latest.s.id;

  return ordered[0].id;
}

export function cutoverOffer(input: LandingInput): CutoverOffer | null {
  const { windowsById, activeId, now, fallbackZone } = input;
  const nowMs = now.getTime();
  const spanOf = (s: SessionRead) => sessionSpan(s, windowsById[s.id] ?? [], fallbackZone);
  const others = orderSessions(input.sessions)
    .filter((s) => s.id !== activeId)
    .flatMap((s) => {
      const span = spanOf(s);
      return span ? [{ s, span }] : [];
    });

  const active = input.sessions.find((s) => s.id === activeId);
  const activeSpan = active ? spanOf(active) : null;

  if (activeSpan) {
    let next: { s: SessionRead; span: SessionSpan } | null = null;
    for (const x of others) {
      if (x.span.start.getTime() < activeSpan.end.getTime()) continue;
      // A session that has already ended is past, not next.
      if (x.span.end.getTime() <= nowMs) continue;
      if (!next || x.span.start < next.span.start) next = x;
    }
    if (!next) return null;
    const a = activeSpan.end.getTime();
    const cutover = a + (next.span.start.getTime() - a) / 2;
    if (cutover <= nowMs && nowMs < next.span.end.getTime()) {
      return { sessionId: next.s.id, startsAt: next.span.start };
    }
    return null;
  }

  const running = others.find((x) => x.span.start.getTime() <= nowMs && nowMs < x.span.end.getTime());
  return running ? { sessionId: running.s.id, startsAt: running.span.start } : null;
}
