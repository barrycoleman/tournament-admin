import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { SessionRead, SkillsType, TeamSummary } from "../types";
import { skillsRuleSentence } from "./skillsRules";
import { useSkillsRankings, type SkillsScope } from "./useSkillsRankings";

/** One skills tab: its rule sentence and one table across every division. */
export function SkillsRankingsPanel({ scope, tab, types }: { scope: SkillsScope; tab: string; types: SkillsType[] }) {
  const { t } = useTranslation();
  const season = scope.kind === "season";
  const rankings = useSkillsRankings(scope, tab);
  const teams = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
    enabled: season,
  });
  const teamById = useMemo(() => new Map((teams.data ?? []).map((team) => [team.id, team])), [teams.data]);
  const sessionLabel = useMemo(
    () => new Map((sessions.data ?? []).map((session) => [session.id, session.label])),
    [sessions.data]
  );
  const label = tab === "overall" ? t("skills.rankings.overallTab") : (types.find((type) => type.key === tab)?.label ?? tab);
  const rows = rankings.data ?? [];

  return (
    <>
      <p className="rankings-rules">{skillsRuleSentence(t, tab, types, season)}</p>
      {rankings.isLoading ? (
        <p>{t("skills.rankings.loading")}</p>
      ) : rankings.isError ? (
        <p className="alert alert-danger" role="alert">
          {t("errors.generic")}
        </p>
      ) : rows.length === 0 ? (
        <p className="table__empty">{t("skills.rankings.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label={label}>
            <thead>
              <tr>
                <th className="table__num">{t("rankings.columnRank")}</th>
                <th>{t("rankings.columnTeam")}</th>
                <th className="table__num">{t("rankings.columnScore")}</th>
                <th>{t("skills.rankings.columnAttempts")}</th>
                {season && <th>{t("skills.rankings.columnSession")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const team = teamById.get(row.team_id);
                return (
                  <tr key={row.team_id}>
                    <td className="table__num">{row.rank}</td>
                    <td>
                      {team?.number ?? row.team_id} <span className="table__secondary">{team?.name ?? ""}</span>
                    </td>
                    <td className="table__num">{row.score}</td>
                    <td>{row.attempts.join(" · ")}</td>
                    {season && <td>{sessionLabel.get(row.session_id) ?? ""}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
