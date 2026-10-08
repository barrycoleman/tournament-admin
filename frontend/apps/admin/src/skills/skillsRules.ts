import type { TFunction } from "i18next";
import type { SkillsType } from "../types";

/** The one sentence explaining a skills rankings tab. */
export function skillsRuleSentence(t: TFunction, tab: string, types: SkillsType[], season: boolean): string {
  const rule =
    tab === "overall"
      ? t("skills.rankings.overallRule", {
          bests: types
            .map((type) => t("skills.rankings.typeBest", { label: type.label }))
            .join(t("skills.rankings.bestsJoin")),
        })
      : t("skills.rankings.typeRule", { label: types.find((type) => type.key === tab)?.label ?? tab });
  return season ? `${rule} ${t("skills.rankings.seasonRule")}` : rule;
}
