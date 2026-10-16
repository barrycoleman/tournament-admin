import { useEffect, useRef, type RefObject } from "react";

/** Reading speed for a scrolling list, in pixels per second. */
export const SCROLL_PX_PER_SECOND = 40;
/** How long a list rests at its top and at its bottom. */
export const EDGE_PAUSE_MS = 3_000;
const TICK_MS = 50;

/** Scrolls a long list slowly and endlessly, pausing at the top and bottom.
 * Calls `onDone` once: after the first full pass, or, when the list already
 * fits, after `fitSeconds` (so a rotation still moves on). */
export function useAutoScroll(
  ref: RefObject<HTMLElement | null>,
  { onDone, fitSeconds = 20 }: { onDone?: () => void; fitSeconds?: number }
): void {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    let position = 0;
    let stage: "top" | "scrolling" | "bottom" = "top";
    let waited = 0;
    let fitWaited = 0;
    let reported = false;
    const report = () => {
      if (!reported) {
        reported = true;
        onDoneRef.current?.();
      }
    };
    const id = setInterval(() => {
      const element = ref.current;
      if (!element) return;
      const max = element.scrollHeight - element.clientHeight;
      if (max <= 1) {
        fitWaited += TICK_MS;
        if (fitWaited >= fitSeconds * 1000) report();
        return;
      }
      if (stage === "scrolling") {
        position = Math.min(max, position + (SCROLL_PX_PER_SECOND * TICK_MS) / 1000);
        element.scrollTop = position;
        if (position >= max) stage = "bottom";
        return;
      }
      waited += TICK_MS;
      if (waited < EDGE_PAUSE_MS) return;
      waited = 0;
      if (stage === "top") {
        stage = "scrolling";
      } else {
        report();
        position = 0;
        element.scrollTop = 0;
        stage = "top";
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [ref, fitSeconds]);
}
