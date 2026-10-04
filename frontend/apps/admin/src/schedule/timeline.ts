export interface TimelineSpan {
  kind: "scheduled" | "draft";
  roundType: string;
  startMs: number;
  /** `Infinity` for a draft round that doesn't fully fit. */
  endMs: number;
}

export interface TimelineSegment {
  kind: "scheduled" | "draft" | "overflow";
  roundType: string;
  leftPct: number;
  widthPct: number;
}

export function segmentsInWindow(windowStartMs: number, windowEndMs: number, spans: TimelineSpan[]): TimelineSegment[] {
  const length = windowEndMs - windowStartMs;
  return spans.flatMap((span) => {
    const start = Math.max(span.startMs, windowStartMs);
    const end = Math.min(span.endMs, windowEndMs);
    if (end <= start) return [];
    return [
      {
        kind: span.kind,
        roundType: span.roundType,
        leftPct: ((start - windowStartMs) / length) * 100,
        widthPct: ((end - start) / length) * 100,
      },
    ];
  });
}

/** The red tail on the last window: how far past its end the plan runs, kept visible but bounded. */
export function overflowSegment(windowStartMs: number, windowEndMs: number, overBySeconds: number): TimelineSegment {
  const share = ((overBySeconds * 1000) / (windowEndMs - windowStartMs)) * 100;
  const widthPct = Math.min(30, Math.max(4, share));
  return { kind: "overflow", roundType: "", leftPct: 100 - widthPct, widthPct };
}
