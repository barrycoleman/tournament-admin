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
import { tableScreenClass } from "../logic/tableScreen";
import type { ScreenModule, ScreenProps } from "../screenTypes";

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
  const allowed = (typeKey: string) => settings.data!.attempts[typeKey] ?? 0;
  return (
    <ScreenFrame title={t("display.rankingsTitle.skills")} context={t("display.context.skillsRankings")} className={tableScreenClass(context)}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table rank-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.rank")}</th>
              <th scope="col">{t("display.col.team")}</th>
              <th scope="col">{t("display.col.name")}</th>
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
                <tr key={row.team_id} data-testid={`rank-row-${row.team_id}`}>
                  <td className={`rank-table__rank${row.rank <= 3 ? " is-top" : ""}`}>{row.rank}</td>
                  <td className="rank-table__number">{team?.number ?? ""}</td>
                  <td className="rank-table__name">{team?.name ?? ""}</td>
                  <td className="rank-table__strong">{row.score}</td>
                  {types.map((type, index) => {
                    const count = used(type.key, row.team_id);
                    return (
                      <td key={type.key}>
                        <span className="rank-table__strong">{count === 0 ? "–" : best(index, row.team_id)}</span>{" "}
                        <span className="rank-table__muted rank-table__used">{`${count}/${allowed(type.key)}`}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const skillsRankingsScreen: ScreenModule = { key: "skills_rankings", scrolls: true, Component: SkillsRankingsScreen };
