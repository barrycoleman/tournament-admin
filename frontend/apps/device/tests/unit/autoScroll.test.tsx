import { useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDGE_PAUSE_MS, SCROLL_PX_PER_SECOND, useAutoScroll } from "../../src/display/useAutoScroll";

function Harness({ contentHeight, onDone, fitSeconds }: { contentHeight: number; onDone: () => void; fitSeconds?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useAutoScroll(ref, { onDone, fitSeconds });
  return (
    <div
      ref={(element) => {
        if (element) {
          Object.defineProperty(element, "scrollHeight", { configurable: true, value: contentHeight });
          Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
        }
        ref.current = element;
      }}
    />
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useAutoScroll", () => {
  it("reports done once it has paused at the top, scrolled to the bottom and paused there", async () => {
    const onDone = vi.fn();
    render(<Harness contentHeight={500} onDone={onDone} />);
    const scrollMs = (400 / SCROLL_PX_PER_SECOND) * 1000;
    await act(() => vi.advanceTimersByTimeAsync(EDGE_PAUSE_MS + scrollMs + EDGE_PAUSE_MS - 500));
    expect(onDone).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(onDone).toHaveBeenCalledTimes(1);
    // It loops, but only reports once.
    await act(() => vi.advanceTimersByTimeAsync(EDGE_PAUSE_MS * 2 + scrollMs + 1_000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a list that fits reports done after fitSeconds instead", async () => {
    const onDone = vi.fn();
    render(<Harness contentHeight={80} onDone={onDone} fitSeconds={5} />);
    await act(() => vi.advanceTimersByTimeAsync(4_900));
    expect(onDone).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
