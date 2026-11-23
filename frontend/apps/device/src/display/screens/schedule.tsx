import { useTranslation } from "react-i18next";
import { formatTime } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatchFormat, useMatches, useRanks, useSessionTimeZone, useTeamsById } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { onFieldMatchIds, roundProgress, scheduleRows } from "../logic/schedule";
import { matchSides } from "../logic/sides";
import { tableScreenClass } from "../logic/tableScreen";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function ScheduleScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const ranks = useRanks(context.sessionId, context.divisionId);
  const timeZone = useSessionTimeZone(context.sessionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.schedule");
  if (!matches.data || !fields.data || !format.data || !teams || timeZone === undefined) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  const kept = matches.data.filter(keep);
  const rows = scheduleRows(kept);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noMoreMatches")} onDone={onDone} fitSeconds={fitSeconds} />;
  const progress = roundProgress(kept);
  const heading = progress ? t(`display.context.${progress.round}`, { played: progress.played, total: progress.total }) : undefined;
  const onField = onFieldMatchIds(kept, fields.data.map((f) => f.id));
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  const numbers = (ids: number[]) => ids.map((id) => <span key={id}>{teams.get(id)?.number ?? ""}</span>);
  return (
    <ScreenFrame title={title} context={heading} className={tableScreenClass(context)}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table rank-table schedule-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.match")}</th>
              <th scope="col">{t("display.col.time")}</th>
              <th scope="col">{t("display.col.field")}</th>
              <th scope="col">{t("display.col.red")}</th>
              <th scope="col">{t("display.col.blue")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((match) => {
              const sides = matchSides(match, ranks);
              const classes = [match.status === "completed" ? "is-done" : "", onField.has(match.id) ? "is-on-field" : ""].filter(Boolean).join(" ");
              return (
                <tr key={match.id} className={classes || undefined}>
                  <th scope="row" className="schedule-table__match">
                    {match.label}
                    {onField.has(match.id) && (
                      <span className="on-field-tag" data-testid="on-field">
                        {t("display.onField")}
                      </span>
                    )}
                  </th>
                  <td className="schedule-table__time">{match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : "–"}</td>
                  <td className="schedule-table__field">{fieldName(match.field_id)}</td>
                  <td className="schedule-table__side schedule-table__side--red">
                    <span className="team-numbers team-numbers--red">{numbers(sides.red)}</span>
                  </td>
                  <td className="schedule-table__side schedule-table__side--blue">
                    <span className="team-numbers team-numbers--blue">{numbers(sides.blue)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const scheduleScreen: ScreenModule = { key: "schedule", scrolls: true, Component: ScheduleScreen };
