import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type ApiRequestOptions } from "../src/api-client";
import type { ScoresheetField } from "../src/scoresheet";
import { SkillsRunPanel, createScoringHub, type ScoringRequest, type SkillsRun, type SkillsSet } from "../src/scoring";
import { t } from "./scoringT";

const AT = "2026-10-19T10:00:00Z";
const SCORE: ScoresheetField = {
  name: "score", label: "Score", data_type: "integer", widget: "counter", min: 0, max: 999, step: 1,
  options: null, icon: null, scope: "team", default: 0,
};
const RUN: SkillsRun = {
  id: 40, field_id: 3, field_set_id: 9, team_id: 7, team_number: "101A", team_name: "Rockets", skills_type: "driver",
  data: { score: 4 }, item_meta: { score: { device_name: "Admin", at: AT } }, version: 1, score: 4,
  follows_set: true, phase: "ended", deadline: null, paused: false, remaining_seconds: 0,
};

let run: SkillsRun | null;
let refuse: Record<string, unknown>;
let request: ReturnType<typeof vi.fn>;

function skillsSet(): SkillsSet {
  return {
    timer: { field_set_id: 9, skills_type: "driver", phase: "ended", deadline: null, paused: false, remaining_seconds: 0, run_seconds: 60 },
    fields: [{ field_id: 3, name: "Skills 1", run }],
  };
}

beforeEach(() => {
  run = RUN;
  refuse = {};
  request = vi.fn(async (path: string, options?: ApiRequestOptions) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in refuse) throw refuse[key];
    if (key === "GET /api/field-sets/9/skills") return skillsSet();
    if (key === "GET /api/skills/types/driver/schema") return [SCORE];
    if (key === "PATCH /api/fields/3/skills-run/draft" && run) {
      const changes = (options?.body as { changes: Record<string, number> }).changes;
      run = { ...run, data: { ...run.data, ...changes }, version: run.version + 1 };
      return run;
    }
    if (key === "POST /api/fields/3/skills-run/submit" || key === "DELETE /api/fields/3/skills-run") {
      run = null;
      return undefined;
    }
    return {};
  });
});

function renderPanel() {
  const hub = createScoringHub();
  render(
    <SkillsRunPanel
      fieldId={3}
      fieldSetId={9}
      t={t}
      myDeviceName="Admin"
      socketEvents={{ connected: true, subscribe: hub.subscribe }}
      request={request as unknown as ScoringRequest}
      typeLabel={(key) => (key === "driver" ? "Driver" : key)}
    />
  );
}

describe("SkillsRunPanel", () => {
  it("shows the team, type and timers and sends a change to the run's draft", async () => {
    renderPanel();
    const panel = await screen.findByRole("region", { name: "Skills 1" });
    expect(within(panel).getByText("101A Rockets · Driver")).toBeInTheDocument();
    expect(within(panel).getByText(/Run over · Following the set timer/)).toBeInTheDocument();
    expect(within(panel).getByRole("group", { name: "Field timer" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Set timer" })).getByRole("button", { name: "Reset timer" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/field-sets/9/skills-timer/reset", { method: "POST" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Increase Score" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/fields/3/skills-run/draft", { method: "PATCH", body: { changes: { score: 5 } } })
    );
  });

  it("lists the problems, submits anyway and shows the saved score", async () => {
    refuse["POST /api/fields/3/skills-run/submit"] = new ApiError(422, "", {
      violations: [{ field: "score", message: "Too high." }],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const problems = await screen.findByRole("alert");
    expect(problems).toHaveTextContent("score: Too high.");
    delete refuse["POST /api/fields/3/skills-run/submit"];
    fireEvent.click(within(problems).getByRole("button", { name: "Submit anyway" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/fields/3/skills-run/submit", { method: "POST", body: { force: true } })
    );
    expect(await screen.findByText("Saved: 101A Rockets · Driver · 4")).toBeInTheDocument();
    expect(screen.getByText("No run on this field.")).toBeInTheDocument();
  });

  it("discards the run after asking", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Discard this run? No attempt is used." })).getByRole("button", { name: "Discard run" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/fields/3/skills-run", { method: "DELETE" }));
    expect(await screen.findByText("No run on this field.")).toBeInTheDocument();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
  });
});
