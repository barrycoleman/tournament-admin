import { useTranslation } from "react-i18next";
import { useMatchFormat, useMatches, useMergedRankings, useScores, useTeamsById, useDivisionFilter } from "../api";
import { MatchSchedulePanel } from "../components/MatchSchedulePanel";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { teamRecords } from "../logic/records";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function TeamworkRankingsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const rankings = useMergedRankings(context.sessionId, context.divisionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.teamwork_rankings");
  if (!rankings || !format.data || !teams || !matches.data || !scores.data) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  if (rankings.length === 0) return <ScreenNotice title={title} text={t("display.noRankings")} onDone={onDone} fitSeconds={fitSeconds} />;
  const cooperative = format.data.game_model === "cooperative_score";
  const records = teamRecords(matches.data.filter(keep), scores.data);
  return (
    <ScreenFrame title={title} className="rankings">
      <div className="split">
        <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
          <table className="kiosk-table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{t("display.col.rank")}</th>
                <th scope="col">{t("display.col.team")}</th>
                {cooperative ? (
                  <>
                    <th scope="col">{t("display.col.matches")}</th>
                    <th scope="col">{t("display.col.average")}</th>
                  </>
                ) : (
                  <>
                    <th scope="col">{t("display.col.winPoints")}</th>
                    <th scope="col">{t("display.col.sos")}</th>
                    <th scope="col">{t("display.col.record")}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rankings.map((row) => {
                const team = teams.get(row.team_id);
                const record = records.get(row.team_id) ?? { wins: 0, losses: 0, ties: 0 };
                return (
                  <tr key={row.team_id}>
                    <td className="kiosk-table__rank">{row.rank}</td>
                    <td>
                      <span className="kiosk-table__number">{team?.number ?? ""}</span> {team?.name ?? ""}
                    </td>
                    {cooperative ? (
                      <>
                        <td>{row.matches_played}</td>
                        <td>{Math.round(row.average_score * 10) / 10}</td>
                      </>
                    ) : (
                      <>
                        <td>{row.win_points}</td>
                        <td>{row.strength_of_schedule}</td>
                        <td>{`${record.wins}-${record.losses}-${record.ties}`}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollingList>
        <MatchSchedulePanel sessionId={context.sessionId} keep={keep} />
      </div>
    </ScreenFrame>
  );
}

export const teamworkRankingsScreen: ScreenModule = {
  key: "teamwork_rankings",
  scrolls: true,
  Component: TeamworkRankingsScreen,
};
