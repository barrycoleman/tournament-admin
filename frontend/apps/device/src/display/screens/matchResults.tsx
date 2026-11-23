import { useTranslation } from "react-i18next";
import { scoredMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useMatchFormat, useMatches, useRanks, useScores, useTeamsById } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { FitLine } from "../components/FitText";
import { ScrollingList } from "../components/ScrollingList";
import { groupScore, matchSides, resultOutcome, scoreGroups } from "../logic/sides";
import { tableScreenClass } from "../logic/tableScreen";
import type { ScreenModule, ScreenProps } from "../screenTypes";

/** Recent results as a scoreboard: newest first, red teams, red score, blue score, blue teams.
 * The losing side is dimmed; a tie dims neither; a cooperative match has one combined score. */
function MatchResultsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const ranks = useRanks(context.sessionId, context.divisionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.match_results");
  if (!matches.data || !scores.data || !format.data || !teams) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  const rows = scoredMatches(matches.data, scores.data, keep);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.nothingScored")} onDone={onDone} fitSeconds={fitSeconds} />;
  const byAlliance = new Map(scores.data.map((s) => [s.alliance_id, s.score]));
  const numbers = (ids: number[]) => ids.map((id) => <span key={id}>{teams.get(id)?.number ?? ""}</span>);
  return (
    <ScreenFrame title={title} className={tableScreenClass(context)}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table rank-table results-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.match")}</th>
              <th scope="col">{t("display.col.red")}</th>
              <th scope="col" colSpan={2}>{t("display.col.score")}</th>
              <th scope="col">{t("display.col.blue")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((match) => {
              const sides = matchSides(match, ranks);
              const groups = scoreGroups(match, format.data!.game_model);
              const outcome = resultOutcome(groups, byAlliance);
              const dim = (side: "red" | "blue") => (outcome !== null && outcome !== "tie" && outcome !== side ? " is-loser" : "");
              return (
                <tr key={match.id}>
                  <th scope="row" className="results-table__match">{match.label}</th>
                  <td className={`results-teams results-teams--red${dim("red")}`}>
                    <FitLine align="end">
                      <span className="team-numbers">{numbers(sides.red)}</span>
                    </FitLine>
                  </td>
                  {groups.map((group) => (
                    <td
                      key={group.side}
                      colSpan={group.side === "combined" ? 2 : 1}
                      className={`score score-${group.side}${group.side === "combined" ? "" : dim(group.side)}`}
                    >
                      {groupScore(group, byAlliance) ?? "–"}
                    </td>
                  ))}
                  <td className={`results-teams results-teams--blue${dim("blue")}`}>
                    <FitLine>
                      <span className="team-numbers">{numbers(sides.blue)}</span>
                    </FitLine>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const matchResultsScreen: ScreenModule = { key: "match_results", scrolls: true, Component: MatchResultsScreen };
