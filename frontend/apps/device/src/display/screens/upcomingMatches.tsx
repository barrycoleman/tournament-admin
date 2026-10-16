import { useTranslation } from "react-i18next";
import { UPCOMING_COUNT, formatTime, onFields, upcomingMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatchFormat, useMatches, useSessionTimeZone, useTeamsById } from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { allianceGroups } from "../logic/alliances";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { fieldIdsOf } from "./inMatch";

function UpcomingMatchesScreen({ context }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(context.sessionId);
  const inDivision = useDivisionFilter(context.divisionId);
  const title = t("display.screens.upcoming_matches");
  if (!matches.data || !fields.data || !format.data || !teams || !timeZone) return <WaitingForData title={title} />;
  const byFieldSet = context.settings.scope === "field_set" && context.fieldSetId !== null;
  const keep = byFieldSet ? onFields(fieldIdsOf(fields.data, context.fieldSetId)) : inDivision;
  const rows = upcomingMatches(matches.data, keep, context.settings.count ?? UPCOMING_COUNT.default);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  return (
    <ScreenFrame title={title}>
      <table className="kiosk-table kiosk-table--large" aria-label={title}>
        <thead>
          <tr>
            <th scope="col">{t("display.col.match")}</th>
            <th scope="col">{t("display.col.teams")}</th>
            <th scope="col">{t("display.col.field")}</th>
            <th scope="col">{t("display.col.time")}</th>
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
              <td>{fieldName(match.field_id)}</td>
              <td>{match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : t("display.upNext")}</td>
            </tr>
          ))}
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
