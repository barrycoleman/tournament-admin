import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DivisionTabs } from "../../src/schedule/DivisionTabs";

const DIVISIONS = [
  { id: 1, event_id: 1, name: "Division 1", target_team_count: null },
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];

function renderTabs(onSelect = vi.fn(), selectedId = 1) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  render(
    <I18nextProvider i18n={i18n}>
      <DivisionTabs divisions={DIVISIONS} counts={new Map([[1, 24], [2, 1]])} selectedId={selectedId} onSelect={onSelect} />
    </I18nextProvider>
  );
  return onSelect;
}

describe("DivisionTabs", () => {
  it("shows each division with its checked-in team count and marks the selected one", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "Division 1 · 24 teams" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Blue · 1 team" })).toHaveAttribute("aria-selected", "false");
  });

  it("selects on click", () => {
    const onSelect = renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Blue · 1 team" }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("moves with the arrow keys, wrapping around", () => {
    const onSelect = renderTabs();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Division 1 · 24 teams" }), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenCalledWith(2);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Division 1 · 24 teams" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });
});
