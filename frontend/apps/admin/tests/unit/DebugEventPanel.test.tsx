import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { initI18n } from "@tournament-admin/shared";
import { DebugEventPanel } from "../../src/components/DebugEventPanel";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    useRealtimeChannel: vi.fn(),
  };
});

import { useRealtimeChannel } from "@tournament-admin/shared";

function renderWithI18n(ui: React.ReactElement) {
  const i18n = initI18n({ en: { translation: { debugPanel: { toggle: "Debug events", empty: "No events received yet." } } } });
  return render(<I18nextProvider i18n={i18n}><>{ui}</></I18nextProvider>);
}

describe("DebugEventPanel", () => {
  it("shows a placeholder message when collapsed and opened with no events yet", () => {
    vi.mocked(useRealtimeChannel).mockImplementation(() => ({ connected: true }));

    renderWithI18n(<DebugEventPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Debug events/ }));

    expect(screen.getByText("No events received yet.")).toBeInTheDocument();
  });

  it("lists a received event's type and payload once opened", () => {
    let capturedOnEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      capturedOnEvent = options.onEvent;
      return { connected: true };
    });

    renderWithI18n(<DebugEventPanel />);
    act(() => {
      capturedOnEvent?.({ type: "active_session_changed", active_session_id: 7 });
    });
    fireEvent.click(screen.getByRole("button", { name: /Debug events/ }));

    expect(screen.getByText(/active_session_changed/)).toBeInTheDocument();
    expect(screen.getByText(/"active_session_id": 7/)).toBeInTheDocument();
  });

  it("keeps only the last 50 events", () => {
    let capturedOnEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      capturedOnEvent = options.onEvent;
      return { connected: true };
    });

    renderWithI18n(<DebugEventPanel />);
    act(() => {
      for (let i = 0; i < 60; i += 1) {
        capturedOnEvent?.({ type: `event-${i}` });
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /Debug events/ }));

    expect(screen.queryByText(/event-0\b/)).not.toBeInTheDocument();
    expect(screen.getByText(/event-59/)).toBeInTheDocument();
  });
});
