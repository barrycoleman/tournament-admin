import { describe, expect, it } from "vitest";
import {
  draftsFromWindows,
  nextWindowDraft,
  summarizeWindows,
  validateWindowDrafts,
  windowsPayload,
  withLastWindowEnd,
} from "../../src/schedule/playingWindows";
import type { PlayingWindowRead } from "../../src/types";

const WINDOWS: PlayingWindowRead[] = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: null, end_utc: null },
  { date: "2026-11-07", start_time: "13:00", end_time: "17:00", start_utc: null, end_utc: null },
  { date: "2026-11-08", start_time: "09:00", end_time: "15:00", start_utc: null, end_utc: null },
];

describe("playing window drafts", () => {
  it("summarizes windows by day", () => {
    expect(summarizeWindows(WINDOWS, "en")).toBe("Sat 09:00–12:00, 13:00–17:00 · Sun 09:00–15:00");
  });

  it("validates drafts", () => {
    const drafts = draftsFromWindows(WINDOWS);
    expect(validateWindowDrafts(drafts)).toBeNull();
    expect(validateWindowDrafts([{ date: "2026-11-07", startTime: "09:00", endTime: "" }])).toBe("incomplete");
    expect(validateWindowDrafts([{ date: "2026-11-07", startTime: "12:00", endTime: "09:00" }])).toBe("endBeforeStart");
    expect(
      validateWindowDrafts([
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
        { date: "2026-11-07", startTime: "11:00", endTime: "13:00" },
      ])
    ).toBe("overlap");
    expect(
      validateWindowDrafts([
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
        { date: "2026-11-07", startTime: "12:00", endTime: "13:00" },
      ])
    ).toBeNull();
  });

  it("sends drafts sorted", () => {
    const drafts = draftsFromWindows(WINDOWS).reverse();
    expect(windowsPayload(drafts).windows.map((w) => `${w.date} ${w.start_time}`)).toEqual([
      "2026-11-07 09:00",
      "2026-11-07 13:00",
      "2026-11-08 09:00",
    ]);
  });

  it("starts a new window where the last one ends, or at 09:00-12:00 on the session date", () => {
    expect(nextWindowDraft(draftsFromWindows(WINDOWS), "2026-11-07", "2026-10-03")).toEqual({
      date: "2026-11-08",
      startTime: "15:00",
      endTime: "",
    });
    expect(nextWindowDraft([], null, "2026-10-03")).toEqual({ date: "2026-10-03", startTime: "09:00", endTime: "12:00" });
  });

  it("extends only the last window", () => {
    expect(withLastWindowEnd(WINDOWS, "15:16").windows.map((w) => w.end_time)).toEqual(["12:00", "17:00", "15:16"]);
  });
});
