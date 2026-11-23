import { useTranslation } from "react-i18next";
import { currentMatchForField } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useTeamsById } from "./api";
import { InMatchView } from "./components/InMatchView";
import { ScreenFrame, ScreenNotice, WaitingForData } from "./components/ScreenFrame";
import { StartCountdown } from "./components/StartCountdown";
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
  const fieldName = fields.data?.find((f) => f.id === fieldId)?.name ?? "";
  if (!matches.data || !teams || !format.data) return <WaitingForData title={fieldName} />;
  const match = currentMatchForField(matches.data, fieldId);
  if (!match) return <ScreenNotice title={fieldName} text={t("display.fieldDone")} />;
  if (match.phase !== "not_started") return <InMatchView match={match} sessionId={sessionId} now={now} />;
  return (
    <ScreenFrame title={matchTitle(t, match)} subtitle={fieldName} className="field-next">
      <div className="field-next__bars">
        {sideGroups(match).map((group) => (
          <div key={group.side} className={`team-bar team-bar--${group.side}`} data-testid={`bar-${group.side}`}>
            {group.teamIds.map((id) => (
              <span key={id} className="team-bar__number">
                {teams.get(id)?.number ?? ""}
              </span>
            ))}
          </div>
        ))}
      </div>
      <StartCountdown scheduledTime={match.scheduled_time} now={now} />
    </ScreenFrame>
  );
}
