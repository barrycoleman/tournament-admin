import { useTranslation } from "react-i18next";
import { formatTime, type LiveMatch } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatches, useRanks, useSessionTimeZone, useTeams } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { compareTeamNumbers, isOnFieldNow, nextMatchesForTeam, shortFieldName } from "../logic/schedule";
import { matchSides } from "../logic/sides";
import { tableScreenClass } from "../logic/tableScreen";
import type { ScreenModule, ScreenProps } from "../screenTypes";

const SLOTS = [0, 1, 2];

function TeamScheduleScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const teams = useTeams();
  const ranks = useRanks(context.sessionId, context.divisionId);
  const timeZone = useSessionTimeZone(context.sessionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.team_schedule");
  if (!matches.data || !fields.data || !teams.data || timeZone === undefined) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  const rows = teams.data.filter(keep).sort((a, b) => compareTeamNumbers(a.number, b.number));
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noTeams")} onDone={onDone} fitSeconds={fitSeconds} />;
  /** "Q13 · F2 · 10:32": the label and field stay together; a long time may wrap below them. */
  const cellText = (match: LiveMatch) => {
    const when = isOnFieldNow(match) ? t("display.now") : match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : "";
    const lead = [match.label, shortFieldName(fields.data!, match.field_id)].filter(Boolean).join(" · ");
    return (
      <>
        <span className="nowrap">{lead}</span>
        {when && <> <span aria-hidden="true">·</span> <span className="nowrap">{when}</span></>}
      </>
    );
  };
  return (
    <ScreenFrame title={title} context={t("display.context.teamSchedule")} className={tableScreenClass(context)}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table rank-table team-schedule-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.team")}</th>
              <th scope="col">{t("display.col.name")}</th>
              <th scope="col">{t("display.col.next")}</th>
              <th scope="col">{t("display.col.then")}</th>
              <th scope="col">{t("display.col.then")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((team) => {
              const next = nextMatchesForTeam(matches.data!, team.id);
              return (
                <tr key={team.id} data-testid={`team-row-${team.id}`}>
                  <th scope="row" className="rank-table__number">{team.number}</th>
                  <td className="rank-table__name rank-table__muted">{team.name}</td>
                  {next.length === 0 ? (
                    <td colSpan={3} className="team-schedule-table__none">{t("display.noMoreForTeam")}</td>
                  ) : (
                    SLOTS.map((slot) => {
                      const match = next[slot];
                      if (!match) return <td key={slot} data-testid={`next-${team.id}-${slot}`} className="team-schedule-table__cell team-schedule-table__empty">–</td>;
                      const side = matchSides(match, ranks).blue.includes(team.id) ? "blue" : "red";
                      return (
                        <td key={slot} data-testid={`next-${team.id}-${slot}`} className="team-schedule-table__cell">
                          <span className={`side-dot side-dot--${side}`} aria-hidden="true" />
                          {cellText(match)}
                        </td>
                      );
                    })
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const teamScheduleScreen: ScreenModule = { key: "team_schedule", scrolls: true, Component: TeamScheduleScreen };
