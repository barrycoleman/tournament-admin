import { useTranslation } from "react-i18next";
import { UPCOMING_COUNT, formatTime, onFields, upcomingMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatchFormat, useMatches, useRanks, useSessionTimeZone, useTeamsById } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { FitLine } from "../components/FitText";
import { matchSides } from "../logic/sides";
import { tableScreenClass } from "../logic/tableScreen";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { fieldIdsOf } from "./inMatch";

function UpcomingMatchesScreen({ context }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const ranks = useRanks(context.sessionId, context.divisionId);
  const timeZone = useSessionTimeZone(context.sessionId);
  const inDivision = useDivisionFilter(context.divisionId);
  const title = t("display.screens.upcoming_matches");
  if (!matches.data || !fields.data || !format.data || !teams || timeZone === undefined) return <WaitingForData title={title} />;
  const byFieldSet = context.settings.scope === "field_set" && context.fieldSetId !== null;
  const keep = byFieldSet ? onFields(fieldIdsOf(fields.data, context.fieldSetId)) : inDivision;
  const rows = upcomingMatches(matches.data, keep, context.settings.count ?? UPCOMING_COUNT.default);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  const numbers = (ids: number[]) => ids.map((id) => <span key={id}>{teams.get(id)?.number ?? ""}</span>);
  return (
    <ScreenFrame title={title} className={tableScreenClass(context)}>
      <table className="kiosk-table rank-table upcoming-table" aria-label={title}>
        <thead>
          <tr>
            <th scope="col">{t("display.col.match")}</th>
            <th scope="col">{t("display.col.red")}</th>
            <th scope="col">{t("display.col.blue")}</th>
            <th scope="col">{t("display.col.field")}</th>
            <th scope="col">{t("display.col.time")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((match) => {
            const sides = matchSides(match, ranks);
            return (
              <tr key={match.id}>
                <th scope="row" className="upcoming-table__match">{match.label}</th>
                <td>
                  <FitLine>
                    <span className="team-numbers team-numbers--red">{numbers(sides.red)}</span>
                  </FitLine>
                </td>
                <td>
                  <FitLine>
                    <span className="team-numbers team-numbers--blue">{numbers(sides.blue)}</span>
                  </FitLine>
                </td>
                <td className="upcoming-table__field">{fieldName(match.field_id)}</td>
                <td className="upcoming-table__time">{match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : t("display.upNext")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScreenFrame>
  );
}

export const upcomingMatchesScreen: ScreenModule = {
  key: "upcoming_matches",
  scrolls: false,
  Component: UpcomingMatchesScreen,
};
