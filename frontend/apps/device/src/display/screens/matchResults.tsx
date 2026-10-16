import { useTranslation } from "react-i18next";
import { scoredMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useMatchFormat, useMatches, useScores, useTeamsById } from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { allianceGroups, groupScore } from "../logic/alliances";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function MatchResultsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.match_results");
  if (!matches.data || !scores.data || !format.data || !teams) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  const rows = scoredMatches(matches.data, scores.data, keep);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.nothingScored")} onDone={onDone} fitSeconds={fitSeconds} />;
  const byAlliance = new Map(scores.data.map((s) => [s.alliance_id, s.score]));
  return (
    <ScreenFrame title={title}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.match")}</th>
              <th scope="col">{t("display.col.teams")}</th>
              <th scope="col">{t("display.col.score")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((match) => (
              <tr key={match.id}>
                <th scope="row">{match.label}</th>
                <td>
                  {allianceGroups(match, format.data!.game_model).map((group) => (
                    <TeamNumbers key={group.station} teamIds={group.teamIds} teams={teams} station={group.station} />
                  ))}
                </td>
                <td className="kiosk-table__scores">
                  {allianceGroups(match, format.data!.game_model).map((group) => {
                    return (
                      <span key={group.station} className={`score score--${group.station}`}>
                        {groupScore(group, byAlliance) ?? "–"}
                      </span>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const matchResultsScreen: ScreenModule = { key: "match_results", scrolls: true, Component: MatchResultsScreen };
