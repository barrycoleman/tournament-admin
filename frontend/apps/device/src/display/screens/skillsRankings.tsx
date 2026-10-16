import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  paths,
  useFetchJson,
  useSkillsAttempts,
  useSkillsRankings,
  useSkillsSettings,
  useTeamsById,
  type SkillsRankingRow,
} from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import type { ScreenModule, ScreenProps } from "../screenTypes";

const TOP = 10;
const RECENT = 8;

/** Event-wide skills standings for the active session (skills are never split by division). */
function SkillsRankingsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const fetchJson = useFetchJson();
  const settings = useSkillsSettings();
  const overall = useSkillsRankings(context.sessionId, "overall");
  const attempts = useSkillsAttempts(context.sessionId);
  const teams = useTeamsById();
  const types = settings.data?.types ?? [];
  const perType = useQueries({
    queries: types.map((type) => ({
      queryKey: ["skillsRankings", context.sessionId, type.key],
      queryFn: () => fetchJson<SkillsRankingRow[]>(paths.skillsRankings(context.sessionId, type.key)),
    })),
  });
  const title = t("display.screens.skills_rankings");
  if (settings.data && !settings.data.enabled) return <ScreenNotice title={title} text={t("display.skillsOff")} onDone={onDone} fitSeconds={fitSeconds} />;
  if (!settings.data || !overall.data || !attempts.data || !teams || perType.some((q) => !q.data)) {
    return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  }
  const best = (typeIndex: number, teamId: number) =>
    perType[typeIndex].data?.find((row) => row.team_id === teamId)?.score ?? 0;
  const used = (typeKey: string, teamId: number) =>
    attempts.data!.filter((a) => a.team_id === teamId && a.skills_type === typeKey).length;
  const labelOf = new Map(types.map((type) => [type.key, type.label]));
  const recent = [...attempts.data].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at)).slice(0, RECENT);
  return (
    <ScreenFrame title={title} className="rankings">
      <div className="split">
        <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
          <table className="kiosk-table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{t("display.col.rank")}</th>
                <th scope="col">{t("display.col.team")}</th>
                <th scope="col">{t("display.col.total")}</th>
                {types.map((type) => (
                  <th key={type.key} scope="col">
                    {type.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overall.data.map((row) => {
                const team = teams.get(row.team_id);
                return (
                  <tr key={row.team_id}>
                    <td className="kiosk-table__rank">{row.rank}</td>
                    <td>
                      <span className="kiosk-table__number">{team?.number ?? ""}</span> {team?.name ?? ""}
                    </td>
                    <td className="kiosk-table__number">{row.score}</td>
                    {types.map((type, index) => (
                      <td key={type.key}>{`${best(index, row.team_id)} / ${used(type.key, row.team_id)}`}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollingList>
        <div className="side-stack">
          <aside className="side-panel" aria-label={t("display.top10")}>
            <h2 className="side-panel__title">{t("display.top10")}</h2>
            <table className="kiosk-table kiosk-table--compact">
              <tbody>
                {overall.data.slice(0, TOP).map((row) => (
                  <tr key={row.team_id}>
                    <td>{row.rank}</td>
                    <td className="kiosk-table__number">{teams.get(row.team_id)?.number ?? ""}</td>
                    <td className="kiosk-table__number">{row.score}</td>
                    <td>{types.map((_, index) => best(index, row.team_id)).join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
          <aside className="side-panel" aria-label={t("display.recentScores")}>
            <h2 className="side-panel__title">{t("display.recentScores")}</h2>
            <table className="kiosk-table kiosk-table--compact">
              <tbody>
                {recent.map((attempt) => (
                  <tr key={attempt.id}>
                    <td className="kiosk-table__number">{teams.get(attempt.team_id)?.number ?? ""}</td>
                    <td>{labelOf.get(attempt.skills_type) ?? attempt.skills_type}</td>
                    <td className="side-panel__end">{attempt.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        </div>
      </div>
    </ScreenFrame>
  );
}

export const skillsRankingsScreen: ScreenModule = { key: "skills_rankings", scrolls: true, Component: SkillsRankingsScreen };
