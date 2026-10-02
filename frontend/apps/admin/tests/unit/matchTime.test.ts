import { describe, expect, it } from "vitest";
import { formatMatchTime, spansMultipleDays } from "../../src/matchTime";

describe("formatMatchTime", () => {
  it("renders in the session's timezone, not the runner's", () => {
    // 2026-11-07 is after the DST change: Los Angeles is UTC-8.
    expect(formatMatchTime("2026-11-07T17:00:00Z", "America/Los_Angeles", false, "en")).toBe("09:00");
  });

  it("includes the date when asked", () => {
    const text = formatMatchTime("2026-11-07T17:00:00Z", "America/Los_Angeles", true, "en");
    expect(text).toContain("Nov 7");
    expect(text).toContain("09:00");
  });

  it("falls back to UTC, labeled, when the session has no timezone", () => {
    expect(formatMatchTime("2026-11-07T17:00:00Z", null, false, "en")).toBe("17:00 UTC");
  });
});

describe("spansMultipleDays", () => {
  it("decides by calendar day in the given timezone", () => {
    const isos = ["2026-11-07T06:30:00Z", "2026-11-07T17:00:00Z"];
    expect(spansMultipleDays(isos, "America/Los_Angeles")).toBe(true);
    expect(spansMultipleDays(isos, null)).toBe(false);
    expect(spansMultipleDays([], "America/Los_Angeles")).toBe(false);
  });
});
