import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingTabs, skillsTabOf, useRankingTabs } from "../rankings/RankingTabs";
import { RankingsView } from "../rankings/RankingsView";
import { describeSeasonRules } from "../rankings/seasonRulesSummary";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import { RANKING_SETTINGS_KEY, useRankingSettings } from "../rankings/useRankingSettings";
import { SkillsRankingsPanel } from "../skills/SkillsRankingsPanel";
import { handleSkillsEvent } from "../skills/liveUpdates";

const SEASON_SCOPE = { kind: "season" as const };

/**
 * Season standings: Teamwork, then a tab per skills type and Overall Skills
 * while skills are on. Event-wide ranking updates and every skills event go
 * out on the active-session channel, so that's the one this page listens to.
 */
export function SeasonRankingsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useRankingSettings();
  const { tabs, selected, select, types } = useRankingTabs();
  const skillsTab = skillsTabOf(selected);
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => {
      const data = realtimeEvent.data as { event_wide?: boolean } | null;
      if (realtimeEvent.event === "ranking_updated" && data?.event_wide) {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(SEASON_SCOPE) });
        // A settings change recomputes everything, so the rules sentence follows.
        queryClient.invalidateQueries({ queryKey: RANKING_SETTINGS_KEY });
      }
      handleSkillsEvent(queryClient, realtimeEvent);
    },
  });

  return (
    <div>
      <h1>{t("rankings.seasonHeading")}</h1>
      <RankingTabs
        tabs={tabs}
        selected={selected}
        onSelect={select}
        label={t("rankings.seasonTabsLabel")}
        idPrefix="season"
      />
      <div role="tabpanel" id="season-panel" aria-labelledby={`season-tab-${selected}`}>
        {skillsTab === null ? (
          <>
            {settings.data?.game_model === "cooperative_score" && (
              <p className="rankings-rules">{describeSeasonRules(t, settings.data)}</p>
            )}
            <RankingsView scope={SEASON_SCOPE} />
          </>
        ) : (
          <SkillsRankingsPanel scope={SEASON_SCOPE} tab={skillsTab} types={types} />
        )}
      </div>
    </div>
  );
}
