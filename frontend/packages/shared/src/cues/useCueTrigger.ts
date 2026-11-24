import { useEffect, useRef } from "react";
import type { Cue } from "./cues";

/** Calls `onCues` with the cues between each reading and the one before.
 * The first reading, and the first after a gap (no reading), never cue. */
export function useCueTrigger<R>(
  reading: R | null,
  compute: (prev: R | null, next: R | null) => Cue[],
  onCues: (cues: Cue[]) => void
): void {
  const previous = useRef<R | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = reading;
    if (before === null || reading === null) return;
    const cues = compute(before, reading);
    if (cues.length > 0) onCues(cues);
  });
}

/** Passes each reading through `hold` against the last one it returned, so
 * a clock that jitters back up keeps its earlier, lower reading (see
 * holdMatchReading); the same object comes back while it is held. */
export function useHeldReading<R>(reading: R | null, hold: (held: R | null, next: R | null) => R | null): R | null {
  const held = useRef<R | null>(null);
  const result = hold(held.current, reading);
  held.current = result;
  return result;
}
