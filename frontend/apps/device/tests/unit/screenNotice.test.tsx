import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import { TokenContext } from "../../src/display/api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../../src/display/components/ScreenFrame";

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

describe("compact heading", () => {
  it("shows the title, the notice text and the event name in one heading row", async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ name: "Spring Open" }), { status: 200 }));
    const { findByText, getByRole, getByText, container } = render(
      <QueryClientProvider client={client}>
        <TokenContext.Provider value={() => "token"}>
          <ScreenNotice title="Rankings" text="Nothing yet" />
        </TokenContext.Provider>
      </QueryClientProvider>
    );
    expect(getByRole("heading", { name: "Rankings" })).toBeInTheDocument();
    expect(getByText("Nothing yet")).toBeInTheDocument();
    expect(await findByText("Spring Open")).toHaveClass("screen__event");
    expect(container.querySelector(".screen__header")).toContainElement(getByRole("heading", { name: "Rankings" }));
  });

  it("shows the context line in place of the subtitle", () => {
    const { getByText, queryByText } = wrap(<ScreenFrame title="T" subtitle="sub" context="ctx" />);
    expect(getByText("ctx")).toHaveClass("screen__context");
    expect(queryByText("sub")).toBeNull();
  });
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
    const waitingDone = vi.fn();
    const noticeDone = vi.fn();
    wrap(<WaitingForData title="T" onDone={waitingDone} fitSeconds={3} />);
    wrap(<ScreenNotice title="U" text="x" onDone={noticeDone} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(waitingDone).toHaveBeenCalledTimes(1);
    expect(noticeDone).not.toHaveBeenCalled();
  });
});
