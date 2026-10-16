import { useTranslation } from "react-i18next";
import { nextMatchForFieldSet } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useTeamsById } from "../api";
import { AllianceBands } from "../components/AllianceBands";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { StartCountdown } from "../components/StartCountdown";
import { matchTitle } from "../matchTitle";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { useServerNow } from "../serverClock";
import { fieldIdsOf } from "./inMatch";

function MatchIntroScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const next =
    matches.data && fields.data
      ? nextMatchForFieldSet(matches.data, fieldIdsOf(fields.data, context.fieldSetId), context.queuedMatchId)
      : null;
  const ranks = useRanks(context.sessionId, next?.division_id ?? context.divisionId);
  const title = t("display.screens.match_intro");
  if (!matches.data || !fields.data || !format.data || !teams) return <WaitingForData title={title} />;
  if (!next) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = fields.data.find((f) => f.id === next.field_id)?.name;
  return (
    <ScreenFrame title={matchTitle(t, next)} subtitle={fieldName} className="intro">
      <StartCountdown scheduledTime={next.scheduled_time} now={now} />
      <AllianceBands match={next} gameModel={format.data.game_model} teams={teams} ranks={ranks} />
    </ScreenFrame>
  );
}

export const matchIntroScreen: ScreenModule = { key: "match_intro", scrolls: false, Component: MatchIntroScreen };
