import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { PlanTimeline } from "../../src/schedule/PlanTimeline";
import type { PlayingWindowRead } from "../../src/types";

const WINDOWS: PlayingWindowRead[] = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: "2026-11-07T17:00:00Z", end_utc: "2026-11-07T20:00:00Z" },
  { date: "2026-11-07", start_time: "13:00", end_time: "15:00", start_utc: "2026-11-07T21:00:00Z", end_utc: "2026-11-07T23:00:00Z" },
  { date: "2026-11-08", start_time: "09:00", end_time: "15:00", start_utc: "2026-11-08T17:00:00Z", end_utc: "2026-11-08T23:00:00Z" },
];

function renderTimeline(overBySeconds: number) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  return render(
    <I18nextProvider i18n={i18n}>
      <PlanTimeline windows={WINDOWS} spans={[]} overBySeconds={overBySeconds} />
    </I18nextProvider>
  );
}

describe("PlanTimeline", () => {
  it("labels each window and the gaps between them as readable text", () => {
    renderTimeline(0);
    expect(screen.getByText("Sat 09:00–12:00")).toBeInTheDocument();
    expect(screen.getByText("Sat 13:00–15:00")).toBeInTheDocument();
    expect(screen.getByText("Sun 09:00–15:00")).toBeInTheDocument();
    expect(screen.getByText("1 h break")).toBeInTheDocument();
    expect(screen.getByText("overnight")).toBeInTheDocument();
  });

  it("hides the decorative bars from assistive technology", () => {
    const { container } = renderTimeline(0);
    const bars = container.querySelectorAll(".plan-timeline__bar");
    expect(bars).toHaveLength(3);
    bars.forEach((bar) => expect(bar).toHaveAttribute("aria-hidden", "true"));
  });

  it("draws an overflow segment in the last window when the plan runs over", () => {
    const { container } = renderTimeline(1800);
    const bars = container.querySelectorAll(".plan-timeline__bar");
    expect(bars[2].querySelector(".plan-timeline__segment--overflow")).not.toBeNull();
    expect(bars[0].querySelector(".plan-timeline__segment--overflow")).toBeNull();
  });
});
