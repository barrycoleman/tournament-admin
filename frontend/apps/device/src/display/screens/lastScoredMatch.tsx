import { useTranslation } from "react-i18next";
import { lastScoredMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useScores, useTeamsById } from "../api";
import { FitText } from "../components/FitText";
import { BottomBar, MatchFrame } from "../components/MatchFrame";
import { ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { groupScore, resultOutcome, scoreGroups, sideGroups } from "../logic/sides";
import { matchTitle } from "../matchTitle";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { fieldIdsOf } from "./inMatch";

function LastScoredMatchScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const match =
    matches.data && scores.data && fields.data
      ? lastScoredMatch(matches.data, scores.data, fieldIdsOf(fields.data, context.fieldSetId))
      : null;
  const ranks = useRanks(context.sessionId, match?.division_id ?? context.divisionId);
  const title = t("display.screens.last_scored_match");
  if (!matches.data || !scores.data || !fields.data || !format.data || !teams) {
    return <WaitingForData title={title} />;
  }
  if (!match) return <ScreenNotice title={title} text={t("display.nothingScored")} />;
  const byAlliance = new Map(scores.data.filter((s) => s.match_id === match.id).map((s) => [s.alliance_id, s.score]));
  const groups = scoreGroups(match, format.data.game_model);
  const combined = groups.find((group) => group.side === "combined");
  const outcome = resultOutcome(groups, byAlliance);
  const fieldName = fields.data.find((f) => f.id === match.field_id)?.name;
  const scoreOf = (side: string) => {
    const group = groups.find((g) => g.side === side);
    return group ? groupScore(group, byAlliance) : null;
  };
  return (
    <MatchFrame
      className={combined ? "result result--combined" : "result"}
      bottom={<BottomBar prefix={t("display.resultPrefix")} title={matchTitle(t, match)} field={fieldName} />}
    >
      <div className="result__sides">
        {sideGroups(match, ranks).map((group) => (
          <section
            key={group.side}
            className={`result-side result-side--${group.side}${outcome !== null && outcome !== "tie" && outcome !== group.side ? " is-loser" : ""}`}
            data-testid={`result-${group.side}`}
            aria-label={t(`display.alliance.${group.side}`)}
          >
            {outcome === group.side && (
              <span className="result-side__winner" data-testid="winner">
                {t("display.winner")}
              </span>
            )}
            {!combined && (
              <p className="result-side__score" data-testid={`score-${group.side}`}>
                {scoreOf(group.side) ?? "–"}
              </p>
            )}
            <div className="result-side__teams">
              {group.teamIds.map((id) => (
                <span key={id} className="result-side__team">
                  <FitText testId={`result-number-${id}`}>{teams.get(id)?.number ?? ""}</FitText>
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>
      {combined && (
        <p className="result__combined" data-testid="score-combined">
          {groupScore(combined, byAlliance) ?? "–"}
        </p>
      )}
    </MatchFrame>
  );
}

export const lastScoredMatchScreen: ScreenModule = {
  key: "last_scored_match",
  scrolls: false,
  Component: LastScoredMatchScreen,
};
