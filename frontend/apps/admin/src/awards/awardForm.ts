import type { TFunction } from "i18next";
import type { AwardBasis, AwardDefinition, AwardKind, AwardScope, AwardSource } from "../types";

/** The award form's editable state; placement stays a string while typed. */
export interface AwardDraft {
  name: string;
  description: string;
  kind: AwardKind;
  scope: AwardScope;
  allDivisions: boolean;
  divisionIds: number[];
  source: AwardSource;
  skillsType: string;
  basis: AwardBasis;
  placement: string;
}

const ALL_SOURCES: AwardSource[] = ["teamwork_ranking", "finals", "skills_overall", "skills_type"];
const RULE_FIELDS = ["kind", "scope", "division_ids", "source", "skills_type", "basis", "placement"] as const;

export function emptyDraft(): AwardDraft {
  return {
    name: "",
    description: "",
    kind: "judged",
    scope: "division",
    allDivisions: true,
    divisionIds: [],
    source: "teamwork_ranking",
    skillsType: "",
    basis: "session",
    placement: "1",
  };
}

/** Teamwork rankings and finals never compare teams across divisions. */
export function allowedSources(scope: AwardScope): AwardSource[] {
  return scope === "event" ? ["skills_overall", "skills_type"] : ALL_SOURCES;
}

export function draftFromAward(award: AwardDefinition): AwardDraft {
  const base = emptyDraft();
  return {
    name: award.name,
    description: award.description ?? "",
    kind: award.kind,
    scope: award.scope,
    allDivisions: award.division_ids.length === 0,
    divisionIds: [...award.division_ids],
    source: award.source ?? base.source,
    skillsType: award.skills_type ?? "",
    basis: award.basis ?? base.basis,
    placement: award.placement === null ? base.placement : String(award.placement),
  };
}

export function draftToBody(draft: AwardDraft): AwardDefinition {
  const description = draft.description.trim();
  const divisionIds =
    draft.scope === "division" && !draft.allDivisions ? [...draft.divisionIds].sort((a, b) => a - b) : [];
  const common = {
    name: draft.name.trim(),
    description: description === "" ? null : description,
    kind: draft.kind,
    scope: draft.scope,
    division_ids: divisionIds,
  };
  if (draft.kind === "judged") {
    return { ...common, source: null, skills_type: null, basis: null, placement: null };
  }
  const source = allowedSources(draft.scope).includes(draft.source) ? draft.source : "skills_overall";
  return {
    ...common,
    source,
    skills_type: source === "skills_type" ? draft.skillsType : null,
    basis: source === "finals" ? "session" : draft.basis,
    placement: Number(draft.placement),
  };
}

/** The first problem with the draft, as an i18n key, or null. */
export function draftError(draft: AwardDraft): string | null {
  if (draft.name.trim() === "") return "awards.form.errors.nameRequired";
  if (draft.scope === "division" && !draft.allDivisions && draft.divisionIds.length === 0) {
    return "awards.form.errors.divisions";
  }
  if (draft.kind === "performance") {
    if (!/^[1-9][0-9]*$/.test(draft.placement.trim())) return "awards.form.errors.placement";
    if (draft.source === "skills_type" && draft.skillsType === "") return "awards.form.errors.skillsType";
  }
  return null;
}

/** Whether saving `body` would clear the award's stored winners. */
export function ruleChanged(award: AwardDefinition, body: AwardDefinition): boolean {
  return RULE_FIELDS.some((field) => JSON.stringify(award[field]) !== JSON.stringify(body[field]));
}

const SOURCE_KEYS: Record<AwardSource, string> = {
  teamwork_ranking: "awards.source.teamworkRanking",
  finals: "awards.source.finals",
  skills_overall: "awards.source.skillsOverall",
  skills_type: "awards.source.skillsType",
};

export function sourceLabel(t: TFunction, award: AwardDefinition, typeLabels: Record<string, string>): string {
  if (award.source === "skills_type") {
    const type = award.skills_type ?? "";
    return t("awards.source.skillsTypeNamed", { type: typeLabels[type] ?? type });
  }
  return award.source ? t(SOURCE_KEYS[award.source]) : "";
}

/** One line describing how the winner is chosen. */
export function ruleSummary(t: TFunction, award: AwardDefinition, typeLabels: Record<string, string>): string {
  const scope = t(`awards.scope.${award.scope}`);
  if (award.kind === "judged") return t("awards.summary.judged", { scope });
  return t("awards.summary.performance", {
    source: sourceLabel(t, award, typeLabels),
    placement: award.placement,
    basis: t(`awards.basis.${award.basis}`),
    scope,
  });
}
