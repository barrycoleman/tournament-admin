import { useTranslation } from "react-i18next";
import { RankingTables } from "./RankingTables";
import { useRankingGroups, type RankingScope } from "./useRankingGroups";
import { useRankingSettings } from "./useRankingSettings";

/** The loading, error, empty and table states for one scope's rankings. */
export function RankingsView({ scope }: { scope: RankingScope }) {
  const { t } = useTranslation();
  const settings = useRankingSettings();
  const { groups, isLoading, isError } = useRankingGroups(scope);

  if (isLoading || settings.isLoading) return <p>{t("rankings.loading")}</p>;
  if (isError || settings.isError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (groups.length === 0) return <p className="table__empty">{t("rankings.empty")}</p>;
  return <RankingTables groups={groups} gameModel={settings.data?.game_model ?? "head_to_head"} />;
}
