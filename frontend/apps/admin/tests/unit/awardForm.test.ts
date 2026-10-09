import { describe, expect, it } from "vitest";
import {
  allowedSources,
  draftError,
  draftFromAward,
  draftToBody,
  emptyDraft,
  ruleChanged,
  ruleSummary,
} from "../../src/awards/awardForm";
import type { AwardDefinition } from "../../src/types";

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key) as never;

const CHAMPION: AwardDefinition = {
  name: "Teamwork Champion",
  description: null,
  kind: "performance",
  scope: "division",
  division_ids: [],
  source: "finals",
  skills_type: null,
  basis: "session",
  placement: 1,
};

describe("awardForm", () => {
  it("offers only skills sources for event scope", () => {
    expect(allowedSources("event")).toEqual(["skills_overall", "skills_type"]);
    expect(allowedSources("division")).toEqual(["teamwork_ranking", "finals", "skills_overall", "skills_type"]);
  });

  it("turns a judged draft into a body with no performance fields", () => {
    const body = draftToBody({ ...emptyDraft(), name: "  Design  ", description: "  ", scope: "event" });
    expect(body).toEqual({
      name: "Design",
      description: null,
      kind: "judged",
      scope: "event",
      division_ids: [],
      source: null,
      skills_type: null,
      basis: null,
      placement: null,
    });
  });

  it("forces session basis for finals and drops a skills type the source does not use", () => {
    const body = draftToBody({
      ...emptyDraft(),
      name: "Champion",
      kind: "performance",
      source: "finals",
      basis: "season",
      skillsType: "driver",
      placement: "2",
    });
    expect(body).toMatchObject({ source: "finals", basis: "session", skills_type: null, placement: 2 });
  });

  it("keeps chosen divisions only when not all divisions", () => {
    const some = draftToBody({ ...emptyDraft(), name: "X", allDivisions: false, divisionIds: [4, 2] });
    expect(some.division_ids).toEqual([2, 4]);
    const all = draftToBody({ ...emptyDraft(), name: "X", allDivisions: true, divisionIds: [4] });
    expect(all.division_ids).toEqual([]);
  });

  it("round-trips an award through a draft", () => {
    expect(draftToBody(draftFromAward(CHAMPION))).toEqual(CHAMPION);
  });

  it("reports the first problem as an i18n key", () => {
    expect(draftError({ ...emptyDraft(), name: " " })).toBe("awards.form.errors.nameRequired");
    const perf = { ...emptyDraft(), name: "X", kind: "performance" as const };
    expect(draftError({ ...perf, placement: "0" })).toBe("awards.form.errors.placement");
    expect(draftError({ ...perf, placement: "1.5" })).toBe("awards.form.errors.placement");
    expect(draftError({ ...perf, placement: "1", source: "skills_type", skillsType: "" })).toBe(
      "awards.form.errors.skillsType"
    );
    expect(draftError({ ...emptyDraft(), name: "X", allDivisions: false, divisionIds: [] })).toBe(
      "awards.form.errors.divisions"
    );
    expect(draftError({ ...perf, placement: "3" })).toBeNull();
  });

  it("detects rule changes but not name changes", () => {
    expect(ruleChanged(CHAMPION, { ...CHAMPION, name: "Other", description: "D" })).toBe(false);
    expect(ruleChanged(CHAMPION, { ...CHAMPION, placement: 2 })).toBe(true);
    expect(ruleChanged(CHAMPION, { ...CHAMPION, division_ids: [3] })).toBe(true);
  });

  it("summarises the rule", () => {
    expect(ruleSummary(t, CHAMPION, {})).toBe(
      'awards.summary.performance:{"source":"awards.source.finals","placement":1,"basis":"awards.basis.session","scope":"awards.scope.division"}'
    );
    expect(ruleSummary(t, { ...CHAMPION, source: "skills_type", skills_type: "driver" }, { driver: "Driver" })).toContain(
      '"source":"awards.source.skillsTypeNamed:{\\"type\\":\\"Driver\\"}"'
    );
    expect(ruleSummary(t, { ...CHAMPION, kind: "judged", scope: "event" }, {})).toBe(
      'awards.summary.judged:{"scope":"awards.scope.event"}'
    );
  });
});
