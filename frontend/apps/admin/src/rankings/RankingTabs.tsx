import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { SkillsType } from "../types";

export const TEAMWORK_TAB = "teamwork";
const SKILLS_PREFIX = "skills-";

export interface RankingTab {
  id: string;
  label: string;
}

/** A skills tab's id from its rankings tab ("overall" or a type key), and back. */
export const skillsTabId = (tab: string) => `${SKILLS_PREFIX}${tab}`;
export function skillsTabOf(tabId: string): string | null {
  return tabId.startsWith(SKILLS_PREFIX) ? tabId.slice(SKILLS_PREFIX.length) : null;
}

/** Teamwork, then each skills type in plugin order, then Overall Skills. The skills tabs show only while skills are on. */
export function useRankingTabs() {
  const { t } = useTranslation();
  const settings = useSkillsSettings();
  const types: SkillsType[] = settings.data?.enabled ? settings.data.types : [];
  const tabs: RankingTab[] = [
    { id: TEAMWORK_TAB, label: t("rankings.teamworkTab") },
    ...types.map((type) => ({ id: skillsTabId(type.key), label: type.label })),
    ...(types.length > 0 ? [{ id: skillsTabId("overall"), label: t("skills.rankings.overallTab") }] : []),
  ];
  const [chosen, setChosen] = useState(TEAMWORK_TAB);
  // If skills are turned off while a skills tab is open, fall back to Teamwork.
  const selected = tabs.some((tab) => tab.id === chosen) ? chosen : TEAMWORK_TAB;
  return { tabs, selected, select: setChosen, types };
}

export function RankingTabs({
  tabs,
  selected,
  onSelect,
  label,
  idPrefix,
}: {
  tabs: RankingTab[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
  idPrefix: string;
}) {
  return (
    <div className="division-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={tab.id === selected}
          aria-controls={`${idPrefix}-panel`}
          className="division-tabs__tab"
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
