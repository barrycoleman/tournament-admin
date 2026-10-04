import { describe, expect, it } from "vitest";
import { overflowSegment, segmentsInWindow } from "../../src/schedule/timeline";

const HOUR = 3_600_000;

describe("timeline geometry", () => {
  it("clips each span to the window and positions it in percent", () => {
    const segments = segmentsInWindow(0, 4 * HOUR, [
      { kind: "scheduled", roundType: "practice", startMs: 0, endMs: HOUR },
      { kind: "draft", roundType: "qualification", startMs: 3 * HOUR, endMs: 6 * HOUR },
      { kind: "draft", roundType: "qualification", startMs: 5 * HOUR, endMs: 7 * HOUR },
    ]);
    expect(segments).toEqual([
      { kind: "scheduled", roundType: "practice", leftPct: 0, widthPct: 25 },
      { kind: "draft", roundType: "qualification", leftPct: 75, widthPct: 25 },
    ]);
  });

  it("treats an open-ended draft span as running to the window's end", () => {
    const [segment] = segmentsInWindow(0, 4 * HOUR, [
      { kind: "draft", roundType: "qualification", startMs: 2 * HOUR, endMs: Number.POSITIVE_INFINITY },
    ]);
    expect(segment).toMatchObject({ leftPct: 50, widthPct: 50 });
  });

  it("draws overflow at the right end, at least 4% and at most 30% wide", () => {
    expect(overflowSegment(0, 4 * HOUR, 60)).toMatchObject({ kind: "overflow", leftPct: 96, widthPct: 4 });
    expect(overflowSegment(0, 4 * HOUR, 7200)).toMatchObject({ leftPct: 70, widthPct: 30 });
  });
});
