import type { TFunction } from "i18next";
import type { RankingSettingsValues } from "../types";

/** One line describing how the season combines matches, for the Season Rankings page. */
export function describeSeasonRules(t: TFunction, settings: RankingSettingsValues): string {
  const parts: string[] = [];
  if (settings.season_keep_best !== null) {
    parts.push(t("rankings.rules.keepBest", { count: settings.season_keep_best }));
  }
  if (settings.season_minimum > 0) {
    parts.push(t("rankings.rules.minimum", { count: settings.season_minimum }));
  }
  if (settings.season_only_session_counted) {
    parts.push(t("rankings.rules.onlySessionCounted"));
  }
  if (parts.length === 0) return t("rankings.rules.plainAverage");
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
