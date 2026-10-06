import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingsView } from "../rankings/RankingsView";
import { describeSeasonRules } from "../rankings/seasonRulesSummary";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import { useRankingSettings } from "../rankings/useRankingSettings";

const SEASON_SCOPE = { kind: "season" as const };

/**
 * Season standings. Teamwork is the only tab for now; the skills spec adds
 * one per skills type plus Overall. Event-wide ranking updates go out on the
 * active-session channel only, so that's the one this page listens to.
 */
export function SeasonRankingsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useRankingSettings();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => {
      const data = realtimeEvent.data as { event_wide?: boolean } | null;
      if (realtimeEvent.event === "ranking_updated" && data?.event_wide) {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(SEASON_SCOPE) });
      }
    },
  });

  return (
    <div>
      <h1>{t("rankings.seasonHeading")}</h1>
      <div className="division-tabs" role="tablist" aria-label={t("rankings.seasonTabsLabel")}>
        <button
          type="button"
          role="tab"
          id="season-tab-teamwork"
          aria-selected={true}
          aria-controls="season-panel"
          className="division-tabs__tab"
        >
          {t("rankings.teamworkTab")}
        </button>
      </div>
      <div role="tabpanel" id="season-panel" aria-labelledby="season-tab-teamwork">
        {settings.data?.game_model === "cooperative_score" && (
          <p className="rankings-rules">{describeSeasonRules(t, settings.data)}</p>
        )}
        <RankingsView scope={SEASON_SCOPE} />
      </div>
    </div>
  );
}
