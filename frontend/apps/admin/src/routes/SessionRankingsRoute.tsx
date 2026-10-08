import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingTabs, skillsTabOf, useRankingTabs } from "../rankings/RankingTabs";
import { RankingsView } from "../rankings/RankingsView";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import { SkillsRankingsPanel } from "../skills/SkillsRankingsPanel";
import { useSkillsLiveUpdates } from "../skills/liveUpdates";
import type { SessionRead } from "../types";

export function SessionRankingsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const scope = { kind: "session" as const, sessionId: session.id };
  useRealtimeChannel({
    path: `/ws/session/${session.id}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "ranking_updated") {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(scope) });
      }
    },
  });
  useSkillsLiveUpdates();
  const { tabs, selected, select, types } = useRankingTabs();
  const skillsTab = skillsTabOf(selected);

  return (
    <div>
      <RankingTabs
        tabs={tabs}
        selected={selected}
        onSelect={select}
        label={t("rankings.seasonTabsLabel")}
        idPrefix="session-rankings"
      />
      <div role="tabpanel" id="session-rankings-panel" aria-labelledby={`session-rankings-tab-${selected}`}>
        {skillsTab === null ? (
          <RankingsView scope={scope} />
        ) : (
          <SkillsRankingsPanel scope={scope} tab={skillsTab} types={types} />
        )}
      </div>
    </div>
  );
}
