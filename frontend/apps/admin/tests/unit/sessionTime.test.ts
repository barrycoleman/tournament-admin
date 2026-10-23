import { describe, expect, it } from "vitest";
import {
  cutoverOffer,
  isSessionToday,
  orderSessions,
  pickLandingSession,
  sessionSpan,
  sessionZone,
} from "../../src/orientation/sessionTime";
import type { PlayingWindowRead, SessionRead } from "../../src/types";

const ZONE = "America/Los_Angeles";

function session(id: number, date: string | null, extra: Partial<SessionRead> = {}): SessionRead {
  return { id, label: `S${id}`, session_date: date, timezone: ZONE, ...extra } as SessionRead;
}

function win(date: string, startUtc: string | null, endUtc: string | null): PlayingWindowRead {
  return { date, start_time: "09:00", end_time: "12:00", start_utc: startUtc, end_utc: endUtc };
}

const iso = (d: Date | undefined) => d?.toISOString();

describe("sessionSpan", () => {
  it("uses the earliest and latest window UTC", () => {
    const span = sessionSpan(
      session(1, "2026-11-07"),
      [
        win("2026-11-07", "2026-11-07T20:00:00Z", "2026-11-07T23:00:00Z"),
        win("2026-11-07", "2026-11-07T17:00:00Z", "2026-11-07T19:00:00Z"),
        win("2026-11-07", null, null),
      ],
      "UTC",
    );
    expect(iso(span?.start)).toBe("2026-11-07T17:00:00.000Z");
    expect(iso(span?.end)).toBe("2026-11-07T23:00:00.000Z");
  });

  it("is the whole day when there are no windows", () => {
    const span = sessionSpan(session(1, "2026-11-07"), [], "UTC");
    expect(iso(span?.start)).toBe("2026-11-07T08:00:00.000Z");
    expect(iso(span?.end)).toBe("2026-11-08T08:00:00.000Z");
  });

  it("handles a daylight saving change day", () => {
    const span = sessionSpan(session(1, "2026-11-01"), [], "UTC");
    expect(iso(span?.start)).toBe("2026-11-01T07:00:00.000Z");
    expect(iso(span?.end)).toBe("2026-11-02T08:00:00.000Z");
  });

  it("uses the fallback zone when the session has none", () => {
    const span = sessionSpan(session(1, "2026-11-07", { timezone: null }), [], ZONE);
    expect(iso(span?.start)).toBe("2026-11-07T08:00:00.000Z");
  });

  it("returns null with no date and no windows", () => {
    expect(sessionSpan(session(1, null), [], ZONE)).toBeNull();
  });
});

describe("isSessionToday", () => {
  const s = session(1, "2026-11-07");

  it("computes today in the session zone, not UTC", () => {
    // 19:00 on 11-07 in Los Angeles, already 11-08 in UTC
    const now = new Date("2026-11-08T03:00:00Z");
    expect(isSessionToday(s, [], now, "UTC")).toBe(true);
    // 17:00 on 11-08 in Los Angeles
    expect(isSessionToday(s, [], new Date("2026-11-09T01:00:00Z"), "UTC")).toBe(false);
  });

  it("uses the fallback zone when the session has no timezone", () => {
    const noZone = session(1, "2026-11-07", { timezone: null });
    const now = new Date("2026-11-08T03:00:00Z");
    expect(isSessionToday(noZone, [], now, ZONE)).toBe(true);
    expect(isSessionToday(noZone, [], now, "UTC")).toBe(false);
  });

  it("is today when a window date matches even if session_date differs", () => {
    const w = [win("2026-11-09", "2026-11-09T17:00:00Z", "2026-11-09T20:00:00Z")];
    const now = new Date("2026-11-09T18:00:00Z");
    expect(isSessionToday(s, w, now, ZONE)).toBe(true);
    expect(isSessionToday(s, [], now, ZONE)).toBe(false);
  });
});

describe("orderSessions", () => {
  it("puts null dates last and breaks ties by id", () => {
    const out = orderSessions([
      session(4, null),
      session(3, "2026-11-08"),
      session(2, "2026-11-07"),
      session(1, "2026-11-08"),
    ]);
    expect(out.map((s) => s.id)).toEqual([2, 1, 3, 4]);
  });
});

describe("pickLandingSession", () => {
  const a = session(1, "2026-11-07");
  const b = session(2, "2026-11-07");
  const windowsById = {
    1: [win("2026-11-07", "2026-11-07T17:00:00Z", "2026-11-07T20:00:00Z")],
    2: [win("2026-11-07", "2026-11-07T21:00:00Z", "2026-11-08T00:00:00Z")],
  };
  const base = { windowsById, fallbackZone: ZONE };

  it("prefers today's active session over another session today", () => {
    const now = new Date("2026-11-07T18:00:00Z");
    expect(pickLandingSession({ ...base, sessions: [a, b], activeId: 2, now })).toBe(2);
  });

  it("prefers the session whose span contains now when the active one isn't today", () => {
    const c = session(3, "2026-11-10");
    const now = new Date("2026-11-07T22:00:00Z");
    expect(pickLandingSession({ ...base, sessions: [a, b, c], activeId: 3, now })).toBe(2);
  });

  it("takes the first of today's sessions when none is active or running", () => {
    const now = new Date("2026-11-07T20:30:00Z");
    expect(pickLandingSession({ ...base, sessions: [b, a], activeId: null, now })).toBe(1);
  });

  it("falls back to active, then the next upcoming, then the most recent", () => {
    const later = new Date("2026-11-20T12:00:00Z");
    expect(pickLandingSession({ ...base, sessions: [a, b], activeId: 1, now: later })).toBe(1);
    expect(pickLandingSession({ ...base, sessions: [a, b], activeId: null, now: later })).toBe(2);
    const earlier = new Date("2026-11-01T12:00:00Z");
    expect(pickLandingSession({ ...base, sessions: [b, a], activeId: null, now: earlier })).toBe(1);
  });

  it("never picks a dateless, windowless session over a dated one", () => {
    const dateless = session(0, null);
    const now = new Date("2026-12-01T12:00:00Z");
    expect(pickLandingSession({ ...base, sessions: [dateless, a, b], activeId: null, now })).toBe(2);
    const early = new Date("2026-10-01T12:00:00Z");
    expect(pickLandingSession({ ...base, sessions: [dateless, a, b], activeId: null, now: early })).toBe(1);
  });

  it("decides today by the session zone date", () => {
    const x = session(1, "2026-11-07");
    const y = session(2, "2026-11-08");
    // 19:00 on 11-07 in Los Angeles, 11-08 in UTC: x is today, not y
    const now = new Date("2026-11-08T03:00:00Z");
    expect(pickLandingSession({ sessions: [y, x], windowsById: {}, activeId: null, now, fallbackZone: "UTC" })).toBe(1);
    // an active session on another day does not beat today's
    expect(pickLandingSession({ sessions: [x, y], windowsById: {}, activeId: 2, now, fallbackZone: "UTC" })).toBe(1);
  });

  it("picks the dateless session only when it is the only one", () => {
    const dateless = session(9, null);
    expect(
      pickLandingSession({ ...base, sessions: [dateless], activeId: null, now: new Date() }),
    ).toBe(9);
  });

  it("returns null for an empty list", () => {
    expect(
      pickLandingSession({ sessions: [], windowsById: {}, activeId: null, now: new Date(), fallbackZone: ZONE }),
    ).toBeNull();
  });
});

describe("cutoverOffer", () => {
  const a = session(1, "2026-11-07");
  const b = session(2, "2026-11-07");
  // 09:00-12:00 and 13:00-17:00 Pacific on 2026-11-07 (PST, UTC-8)
  const sameDay = {
    1: [win("2026-11-07", "2026-11-07T17:00:00Z", "2026-11-07T20:00:00Z")],
    2: [win("2026-11-07", "2026-11-07T21:00:00Z", "2026-11-08T01:00:00Z")],
  };
  const run = (now: string, extra: Partial<Parameters<typeof cutoverOffer>[0]> = {}) =>
    cutoverOffer({
      sessions: [a, b],
      windowsById: sameDay,
      activeId: 1,
      now: new Date(now),
      fallbackZone: ZONE,
      ...extra,
    });

  it("offers B from the midpoint of the gap until B ends", () => {
    expect(run("2026-11-07T20:29:00Z")).toBeNull();
    const offer = run("2026-11-07T20:30:00Z");
    expect(offer?.sessionId).toBe(2);
    expect(iso(offer?.startsAt)).toBe("2026-11-07T21:00:00.000Z");
    expect(run("2026-11-08T01:00:00Z")).toBeNull();
  });

  it("puts the cutover overnight for Saturday and Sunday sessions", () => {
    const sat = session(1, "2026-11-07");
    const sun = session(2, "2026-11-08");
    const windowsById = {
      1: [win("2026-11-07", "2026-11-07T17:00:00Z", "2026-11-08T01:00:00Z")],
      2: [win("2026-11-08", "2026-11-08T17:00:00Z", "2026-11-09T01:00:00Z")],
    };
    const at = (now: string) =>
      cutoverOffer({ sessions: [sat, sun], windowsById, activeId: 1, now: new Date(now), fallbackZone: ZONE });
    // gap 01:00Z to 17:00Z, midpoint 09:00Z
    expect(at("2026-11-08T08:59:00Z")).toBeNull();
    expect(at("2026-11-08T09:00:00Z")?.sessionId).toBe(2);
  });

  it("offers the session running now when nothing is active", () => {
    const offer = run("2026-11-07T22:00:00Z", { activeId: null });
    expect(offer?.sessionId).toBe(2);
    expect(iso(offer?.startsAt)).toBe("2026-11-07T21:00:00.000Z");
    expect(run("2026-11-07T20:30:00Z", { activeId: null })).toBeNull();
  });

  it("offers the running session when the active one has no span", () => {
    const dateless = session(5, null);
    const offer = cutoverOffer({
      sessions: [dateless, b],
      windowsById: sameDay,
      activeId: 5,
      now: new Date("2026-11-07T22:00:00Z"),
      fallbackZone: ZONE,
    });
    expect(offer?.sessionId).toBe(2);
  });

  it("never offers the active session", () => {
    expect(run("2026-11-07T22:00:00Z", { activeId: 2 })).toBeNull();
    expect(run("2026-11-07T18:00:00Z", { activeId: 1 })).toBeNull();
  });

  it("never offers a dateless session", () => {
    const dateless = session(7, null);
    expect(
      cutoverOffer({
        sessions: [a, dateless],
        windowsById: { 1: sameDay[1] },
        activeId: 1,
        now: new Date("2026-11-30T12:00:00Z"),
        fallbackZone: ZONE,
      }),
    ).toBeNull();
    expect(
      cutoverOffer({
        sessions: [dateless],
        windowsById: {},
        activeId: null,
        now: new Date("2026-11-07T22:00:00Z"),
        fallbackZone: ZONE,
      }),
    ).toBeNull();
  });

  it("offers the real upcoming session, skipping a dateless one", () => {
    const dateless = session(7, null);
    const sessions = [a, dateless, b];
    const windowsById = { 1: sameDay[1], 2: sameDay[2] };
    expect(
      cutoverOffer({ sessions, windowsById, activeId: 1, now: new Date("2026-11-07T20:30:00Z"), fallbackZone: ZONE })
        ?.sessionId,
    ).toBe(2);
    expect(
      cutoverOffer({ sessions, windowsById, activeId: null, now: new Date("2026-11-07T22:00:00Z"), fallbackZone: ZONE })
        ?.sessionId,
    ).toBe(2);
  });

  it("handles two sessions on the same date for landing and offer", () => {
    const now = new Date("2026-11-07T22:00:00Z");
    expect(
      pickLandingSession({ sessions: [a, b], windowsById: sameDay, activeId: 1, now, fallbackZone: ZONE }),
    ).toBe(1);
    expect(
      pickLandingSession({ sessions: [a, b], windowsById: sameDay, activeId: null, now, fallbackZone: ZONE }),
    ).toBe(2);
    expect(run("2026-11-07T22:00:00Z", { activeId: 1 })?.sessionId).toBe(2);
    expect(run("2026-11-07T22:00:00Z", { activeId: 2 })).toBeNull();
  });
});

describe("cutoverOffer past sessions", () => {
  it("skips a session that has already ended and offers the one running now", () => {
    const lastWeek = session(1, "2026-10-31");
    const yesterday = session(2, "2026-11-06");
    const today = session(3, "2026-11-07");
    const windowsById = {
      1: [win("2026-10-31", "2026-10-31T16:00:00Z", "2026-11-01T00:00:00Z")],
      2: [win("2026-11-06", "2026-11-06T17:00:00Z", "2026-11-07T01:00:00Z")],
      3: [win("2026-11-07", "2026-11-07T17:00:00Z", "2026-11-08T01:00:00Z")],
    };
    const offer = cutoverOffer({
      sessions: [lastWeek, yesterday, today],
      windowsById,
      activeId: 1,
      now: new Date("2026-11-07T18:00:00Z"),
      fallbackZone: ZONE,
    });
    expect(offer?.sessionId).toBe(3);
    expect(iso(offer?.startsAt)).toBe("2026-11-07T17:00:00.000Z");
  });
});

describe("invalid timezones", () => {
  const broken = session(1, "2026-11-07", { timezone: "Not/AZone" });

  it("falls back to the fallback zone instead of throwing", () => {
    const span = sessionSpan(broken, [], ZONE);
    expect(iso(span?.start)).toBe("2026-11-07T08:00:00.000Z");
    expect(isSessionToday(broken, [], new Date("2026-11-08T03:00:00Z"), ZONE)).toBe(true);
    expect(() =>
      cutoverOffer({ sessions: [broken], windowsById: {}, activeId: null, now: new Date("2026-11-07T20:00:00Z"), fallbackZone: ZONE }),
    ).not.toThrow();
    expect(
      pickLandingSession({ sessions: [broken], windowsById: {}, activeId: null, now: new Date("2026-11-07T20:00:00Z"), fallbackZone: ZONE }),
    ).toBe(1);
  });

  it("resolves a session's zone, falling back when it is missing or invalid", () => {
    expect(sessionZone(broken, ZONE)).toBe(ZONE);
    expect(sessionZone(session(2, null, { timezone: null }), "UTC")).toBe("UTC");
    expect(sessionZone(session(3, null, { timezone: "Europe/London" }), "UTC")).toBe("Europe/London");
  });
});
