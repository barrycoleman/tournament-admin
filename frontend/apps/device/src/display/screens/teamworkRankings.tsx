import { useTranslation } from "react-i18next";
import { isFinished } from "@tournament-admin/shared";
import { useMatchFormat, useMatches, useMergedRankings, useScores, useTeamsById, useDivisionFilter } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { teamRecords } from "../logic/records";
import { tableScreenClass } from "../logic/tableScreen";
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
  const kept = matches.data.filter(keep);
  const records = teamRecords(kept, scores.data);
  const qualification = kept.filter((m) => m.round_type === "qualification");
  const played = qualification.filter(isFinished).length;
  const progress = t("display.context.rankingsProgress", { played, total: qualification.length });
  return (
    <ScreenFrame title={t("display.rankingsTitle")} context={progress} className={tableScreenClass(context)}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table rank-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.rank")}</th>
              <th scope="col">{t("display.col.team")}</th>
              <th scope="col">{t("display.col.name")}</th>
              {cooperative ? (
                <>
                  <th scope="col">{t("display.col.matches")}</th>
                  <th scope="col">{t("display.col.average")}</th>
                </>
              ) : (
                <>
                  <th scope="col">{t("display.col.record")}</th>
                  <th scope="col">{t("display.col.winPoints")}</th>
                  <th scope="col">{t("display.col.sos")}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rankings.map((row) => {
              const team = teams.get(row.team_id);
              const record = records.get(row.team_id) ?? { wins: 0, losses: 0, ties: 0 };
              return (
                <tr key={row.team_id} data-testid={`rank-row-${row.team_id}`}>
                  <td className={`rank-table__rank${row.rank <= 3 ? " is-top" : ""}`}>{row.rank}</td>
                  <td className="rank-table__number">{team?.number ?? ""}</td>
                  <td className="rank-table__name">{team?.name ?? ""}</td>
                  {cooperative ? (
                    <>
                      <td>{row.matches_played}</td>
                      <td className="rank-table__strong">{Math.round(row.average_score * 10) / 10}</td>
                    </>
                  ) : (
                    <>
                      <td className="rank-table__muted">{`${record.wins}-${record.losses}-${record.ties}`}</td>
                      <td className="rank-table__strong">{row.win_points}</td>
                      <td>{row.strength_of_schedule}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const teamworkRankingsScreen: ScreenModule = {
  key: "teamwork_rankings",
  scrolls: true,
  Component: TeamworkRankingsScreen,
};
