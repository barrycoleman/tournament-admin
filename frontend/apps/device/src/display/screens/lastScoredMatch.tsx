import { useTranslation } from "react-i18next";
import { lastScoredMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useScores, useScoresheetSchema, useTeamsById } from "../api";
import { AllianceBands } from "../components/AllianceBands";
import { ScoreBreakdown } from "../components/ScoreBreakdown";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { matchTitle } from "../matchTitle";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { fieldIdsOf } from "./inMatch";

function LastScoredMatchScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const schema = useScoresheetSchema();
  const teams = useTeamsById();
  const match =
    matches.data && scores.data && fields.data
      ? lastScoredMatch(matches.data, scores.data, fieldIdsOf(fields.data, context.fieldSetId))
      : null;
  const ranks = useRanks(context.sessionId, match?.division_id ?? context.divisionId);
  const title = t("display.screens.last_scored_match");
  if (!matches.data || !scores.data || !fields.data || !format.data || !schema.data || !teams) {
    return <WaitingForData title={title} />;
  }
  if (!match) return <ScreenNotice title={title} text={t("display.nothingScored")} />;
  const own = scores.data.filter((s) => s.match_id === match.id);
  return (
    <ScreenFrame title={matchTitle(t, match)} className="result">
      <ScoreBreakdown
        match={match}
        gameModel={format.data.game_model}
        schema={schema.data}
        sheets={new Map(own.map((s) => [s.alliance_id, s.data]))}
      />
      <AllianceBands
        match={match}
        gameModel={format.data.game_model}
        teams={teams}
        ranks={ranks}
        scores={new Map(own.map((s) => [s.alliance_id, s.score]))}
      />
    </ScreenFrame>
  );
}

export const lastScoredMatchScreen: ScreenModule = {
  key: "last_scored_match",
  scrolls: false,
  Component: LastScoredMatchScreen,
};
