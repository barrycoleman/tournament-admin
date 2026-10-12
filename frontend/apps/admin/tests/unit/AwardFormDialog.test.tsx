import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AwardFormDialog } from "../../src/awards/AwardFormDialog";
import type { AwardRead } from "../../src/types";
import type { SourceAvailability } from "../../src/awards/awardForm";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SKILLS_EVENT_AWARD: AwardRead = {
  id: 9,
  session_id: 5,
  position: 0,
  name: "Skills Champion",
  description: null,
  kind: "performance",
  scope: "event",
  division_ids: [],
  source: "skills_overall",
  skills_type: null,
  basis: "session",
  placement: 1,
  slots: [
    {
      division_id: null,
      division_name: null,
      status: "no_result",
      winners: [],
      override_reason: null,
      note: "skills_disabled",
      moved_team_ids: [],
    },
  ],
};

function renderDialog({ award, availability }: { award: AwardRead | null; availability: SourceAvailability }) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <AwardFormDialog
          sessionId={5}
          award={award}
          divisions={[]}
          skillsTypes={[]}
          availability={availability}
          onClose={() => {}}
        />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockResolvedValue({} as never);
});

describe("AwardFormDialog availability", () => {
  it("disables Performance with the reason when there is no game plugin", () => {
    renderDialog({ award: null, availability: { pluginSelected: false, skillsEnabled: false } });
    expect(screen.getByRole("radio", { name: "Performance" })).toBeDisabled();
    expect(screen.getByText("Needs a game plugin.")).toBeInTheDocument();
  });

  it("offers only teamwork and finals while skills are off", () => {
    renderDialog({ award: null, availability: { pluginSelected: true, skillsEnabled: false } });
    fireEvent.click(screen.getByRole("radio", { name: "Performance" }));
    const options = within(screen.getByRole("combobox", { name: "Winner comes from" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Teamwork ranking", "Finals placement"]);
  });

  it("falls back to judged when the chosen scope cannot produce a performance winner", () => {
    renderDialog({ award: null, availability: { pluginSelected: true, skillsEnabled: false } });
    fireEvent.click(screen.getByRole("radio", { name: "Performance" }));
    fireEvent.click(screen.getByRole("radio", { name: "Event-wide (one winner)" }));
    expect(screen.getByRole("radio", { name: "Performance" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Judged" })).toBeChecked();
    expect(
      screen.getByText("Event-wide performance awards come from skills challenges, which are off.")
    ).toBeInTheDocument();
  });

  it("keeps an existing skills award's source, marked not available, so a rename saves", async () => {
    renderDialog({ award: SKILLS_EVENT_AWARD, availability: { pluginSelected: true, skillsEnabled: false } });
    const source = screen.getByRole("combobox", { name: "Winner comes from" });
    expect(source).toHaveDisplayValue("Overall skills (not available)");
    fireEvent.change(screen.getByLabelText("Award name"), { target: { value: "Robot Skills Champion" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save award" }));
    });
    await vi.waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        `/api/awards/${SKILLS_EVENT_AWARD.id}`,
        expect.objectContaining({ method: "PATCH", body: expect.objectContaining({ source: "skills_overall" }) })
      )
    );
  });
});
