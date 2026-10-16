import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import { TokenContext } from "../../src/display/api";
import { ScreenNotice, WaitingForData } from "../../src/display/components/ScreenFrame";

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
  return render(
    <QueryClientProvider client={client}>
      <TokenContext.Provider value={() => "token"}>{ui}</TokenContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("notice rotation timer", () => {
  it("a notice given onDone and fitSeconds reports done once after fitSeconds", async () => {
    const onDone = vi.fn();
    wrap(<ScreenNotice title="T" text="Nothing" onDone={onDone} fitSeconds={5} />);
    await act(() => vi.advanceTimersByTimeAsync(4_900));
    expect(onDone).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a waiting notice reports done too, and a notice without both props never does", async () => {
    const onDone = vi.fn();
    wrap(<WaitingForData title="T" onDone={onDone} fitSeconds={3} />);
    wrap(<ScreenNotice title="U" text="x" onDone={onDone} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
