import { useTranslation } from "react-i18next";
import { formatTime, sortMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatchFormat, useMatches, useSessionTimeZone, useTeamsById } from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { allianceGroups } from "../logic/alliances";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function ScheduleScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(context.sessionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.schedule");
  if (!matches.data || !fields.data || !format.data || !teams || timeZone === undefined) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  const rows = sortMatches(matches.data.filter((m) => keep(m) && m.status !== "not_played"));
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noMoreMatches")} onDone={onDone} fitSeconds={fitSeconds} />;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  return (
    <ScreenFrame title={title}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table" aria-label={title}>
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
              <tr key={match.id} className={match.status === "completed" ? "is-done" : undefined}>
                <th scope="row">{match.label}</th>
                <td>
                  {allianceGroups(match, format.data!.game_model).map((group) => (
                    <TeamNumbers key={group.station} teamIds={group.teamIds} teams={teams} station={group.station} />
                  ))}
                </td>
                <td>{fieldName(match.field_id)}</td>
                <td>{match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const scheduleScreen: ScreenModule = { key: "schedule", scrolls: true, Component: ScheduleScreen };
