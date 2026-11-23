import { useTranslation } from "react-i18next";
import { currentMatchForField } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useTeamsById } from "./api";
import { InMatchView } from "./components/InMatchView";
import { BottomBar, MatchFrame } from "./components/MatchFrame";
import { ScreenNotice, WaitingForData } from "./components/ScreenFrame";
import { StartCountdown } from "./components/StartCountdown";
import { TeamBand } from "./components/TeamBand";
import { sideGroups } from "./logic/sides";
import { matchTitle } from "./matchTitle";
import { useServerNow } from "./serverClock";

/** A field's own monitor: its next match in numbers big enough for the
 * referees' robot check, then the count-in and clock, then the next match
 * once the score is saved. */
export function FieldDisplay({ sessionId, fieldId }: { sessionId: number; fieldId: number }) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(sessionId);
  const fields = useFields(sessionId);
  const teams = useTeamsById();
  const format = useMatchFormat();
  const current = matches.data ? currentMatchForField(matches.data, fieldId) : undefined;
  // Ranks only decide the sides of a score-chase run; they are never shown here.
  const ranks = useRanks(sessionId, current?.division_id ?? null);
  const fieldName = fields.data?.find((f) => f.id === fieldId)?.name ?? "";
  if (!matches.data || !teams || !format.data) return <WaitingForData title={fieldName} />;
  const match = currentMatchForField(matches.data, fieldId);
  if (!match) return <ScreenNotice title={fieldName} text={t("display.fieldDone")} />;
  if (match.phase !== "not_started") return <InMatchView match={match} sessionId={sessionId} now={now} />;
  return (
    <MatchFrame
      className="field-next"
      bottom={<BottomBar title={matchTitle(t, match)} field={fieldName} end={<StartCountdown scheduledTime={match.scheduled_time} now={now} />} />}
    >
      {sideGroups(match, ranks).map((group) => (
        <TeamBand key={group.side} side={group.side} teamIds={group.teamIds} teams={teams} orientation="fill" />
      ))}
    </MatchFrame>
  );
}
