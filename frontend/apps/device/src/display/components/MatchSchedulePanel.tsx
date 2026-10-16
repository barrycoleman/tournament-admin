import { useTranslation } from "react-i18next";
import { formatTime, scoredMatches, upcomingMatches, type LiveMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useScores, useSessionTimeZone, useTeamsById } from "../api";
import { allianceGroups } from "../logic/alliances";
import { TeamNumbers, scoreText } from "./MatchCells";

const RECENT = 5;
const NEXT = 5;

/** The side panel: the latest scored matches, then the next ones with field and time. */
export function MatchSchedulePanel({ sessionId, keep }: { sessionId: number; keep: (match: LiveMatch) => boolean }) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(sessionId);
  const scores = useScores(sessionId);
  const fields = useFields(sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(sessionId);
  if (!matches.data || !scores.data || !fields.data || !format.data || !teams || !timeZone) return null;
  const recent = scoredMatches(matches.data, scores.data, keep).slice(0, RECENT).reverse();
  const next = upcomingMatches(matches.data, keep, NEXT);
  const gameModel = format.data.game_model;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  const row = (match: LiveMatch, done: boolean) => (
    <tr key={match.id} className={done ? "is-done" : undefined}>
      <th scope="row">{match.label}</th>
      {allianceGroups(match, gameModel).map((group) => (
        <td key={group.station}>
          <TeamNumbers teamIds={group.teamIds} teams={teams} station={group.station} />
        </td>
      ))}
      <td className="side-panel__end">
        {done ? (
          scoreText(match, scores.data!, gameModel)
        ) : (
          <>
            {fieldName(match.field_id)} {match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : ""}
          </>
        )}
      </td>
    </tr>
  );
  return (
    <aside className="side-panel" aria-label={t("display.schedulePanel")}>
      <h2 className="side-panel__title">{t("display.schedulePanel")}</h2>
      <table className="kiosk-table kiosk-table--compact">
        <tbody>
          {recent.map((m) => row(m, true))}
          {next.map((m) => row(m, false))}
        </tbody>
      </table>
    </aside>
  );
}
