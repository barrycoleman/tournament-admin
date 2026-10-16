import { useTranslation } from "react-i18next";
import { latestStartedMatchForFieldSet } from "@tournament-admin/shared";
import { useFields, useMatches } from "../api";
import { InMatchView } from "../components/InMatchView";
import { ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { useServerNow } from "../serverClock";

export function fieldIdsOf(fields: { id: number; field_set_id: number }[], fieldSetId: number | null): number[] {
  return fields.filter((f) => fieldSetId === null || f.field_set_id === fieldSetId).map((f) => f.id);
}

function InMatchScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const title = t("display.screens.in_match");
  if (!matches.data || !fields.data) return <WaitingForData title={title} />;
  const match = latestStartedMatchForFieldSet(matches.data, fieldIdsOf(fields.data, context.fieldSetId));
  if (!match) return <ScreenNotice title={title} text={t("display.noMatchYet")} />;
  return <InMatchView match={match} sessionId={context.sessionId} now={now} />;
}

export const inMatchScreen: ScreenModule = { key: "in_match", scrolls: false, Component: InMatchScreen };
