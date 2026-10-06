import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { GameModel, TeamSummary } from "../types";
import type { RankingGroup } from "./useRankingGroups";

/** One table per division group; headings only when there's more than one group. */
export function RankingTables({ groups, gameModel }: { groups: RankingGroup[]; gameModel: GameModel }) {
  const { t, i18n } = useTranslation();
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const teamById = useMemo(() => new Map((teams ?? []).map((team) => [team.id, team])), [teams]);
  const cooperative = gameModel === "cooperative_score";
  const showHeadings = groups.length > 1;
  const score = (value: number) =>
    value.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plain = (value: number) => value.toLocaleString(i18n.language, { maximumFractionDigits: 2 });

  return (
    <>
      {groups.map((group) => {
        const label = group.divisionName ?? (showHeadings ? t("rankings.noDivision") : t("rankings.tableLabel"));
        return (
          <section className="rankings-group" key={group.divisionId ?? "none"}>
            {showHeadings && <h2>{label}</h2>}
            <div className="table-wrap">
              <table className="table" aria-label={label}>
                <thead>
                  <tr>
                    <th className="table__num">{t("rankings.columnRank")}</th>
                    <th>{t("rankings.columnTeam")}</th>
                    <th>{t("rankings.columnName")}</th>
                    {cooperative ? (
                      <>
                        <th className="table__num">{t("rankings.columnScore")}</th>
                        <th className="table__num">{t("rankings.columnMatchesPlayed")}</th>
                      </>
                    ) : (
                      <>
                        <th className="table__num">{t("rankings.columnWinPoints")}</th>
                        <th className="table__num">{t("rankings.columnStrength")}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {[...group.rows]
                    .sort((a, b) => a.rank - b.rank)
                    .map((row) => {
                      const team = teamById.get(row.team_id);
                      return (
                        <tr key={row.team_id}>
                          <td className="table__num">{row.rank}</td>
                          <td>{team?.number ?? row.team_id}</td>
                          <td>{team?.name ?? ""}</td>
                          {cooperative ? (
                            <>
                              <td className="table__num">{score(row.average_score)}</td>
                              <td className="table__num">{row.matches_played}</td>
                            </>
                          ) : (
                            <>
                              <td className="table__num">{row.win_points}</td>
                              <td className="table__num">{plain(row.strength_of_schedule)}</td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
