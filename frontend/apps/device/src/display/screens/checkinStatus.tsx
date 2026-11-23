import { useTranslation } from "react-i18next";
import { useDivisionFilter, useParticipants, useSessions, useTeamsById } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { checkinSummary } from "../logic/checkin";
import type { ScreenModule, ScreenProps } from "../screenTypes";

/** More than this many teams and the grid goes to four columns. */
const FOUR_COLUMNS_ABOVE = 30;

type IconName = "out" | "in" | "total";

/** Dashed ring: not checked in. White ring: checked in. Filled ring with a tick: the checked-in total. */
function Icon({ name }: { name: IconName }) {
  return (
    <svg className={`checkin-icon checkin-icon--${name}`} viewBox="0 0 24 24" aria-hidden="true">
      {name === "out" && <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />}
      {name === "in" && <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" />}
      {name === "total" && (
        <>
          <circle cx="12" cy="12" r="10" fill="currentColor" />
          <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#0e0d0b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function CheckinStatusScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const participants = useParticipants(context.sessionId);
  const teams = useTeamsById();
  const sessions = useSessions();
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.checkin.title");
  if (!participants.data || !teams || !sessions.data) return <WaitingForData title={title} onDone={onDone} fitSeconds={fitSeconds} />;
  const summary = checkinSummary(participants.data, teams, keep);
  if (summary.rows.length === 0) return <ScreenNotice title={title} text={t("display.checkin.none")} onDone={onDone} fitSeconds={fitSeconds} />;
  const sessionLabel = sessions.data.find((s) => s.id === context.sessionId)?.label ?? "";
  return (
    <ScreenFrame title={title} context={sessionLabel} className={`checkin ${context.fieldSetId === null ? "checkin--pit" : "checkin--audience"}`}>
      <div className="checkin-totals">
        <div className="checkin-total checkin-total--in" data-testid="total-in">
          <Icon name="total" />
          <div>
            <div className="checkin-total__count">{summary.checkedIn} <small>/ {summary.total}</small></div>
            <div className="checkin-total__label">{t("display.checkin.checkedIn")}</div>
          </div>
        </div>
        <div className="checkin-total checkin-total--out" data-testid="total-out">
          <Icon name="out" />
          <div>
            <div className="checkin-total__count">{summary.total - summary.checkedIn} <small>/ {summary.total}</small></div>
            <div className="checkin-total__label">{t("display.checkin.notCheckedIn")}</div>
          </div>
        </div>
      </div>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <div className={`checkin-grid${summary.total > FOUR_COLUMNS_ABOVE ? " checkin-grid--four" : ""}`}>
          {summary.rows.map(({ team, checkedIn }) => (
            <div key={team.id} className="checkin-tile" data-testid={`checkin-${team.id}`} data-state={checkedIn ? "in" : "out"}>
              <Icon name={checkedIn ? "in" : "out"} />
              <span className="checkin-tile__number">{team.number}</span>
              <span className="checkin-tile__name">{team.name}</span>
            </div>
          ))}
        </div>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const checkinStatusScreen: ScreenModule = { key: "checkin_status", scrolls: true, Component: CheckinStatusScreen };
