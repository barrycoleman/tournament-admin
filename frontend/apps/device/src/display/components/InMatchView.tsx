import { useTranslation } from "react-i18next";
import { COUNT_IN_PHASES, formatClock, remainingSeconds, type LiveMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useRanks, useTeamsById } from "../api";
import { allianceGroups, groupScore } from "../logic/alliances";
import { matchTitle } from "../matchTitle";
import { useLiveScores } from "../useLiveScores";
import { PeriodIcon } from "./PeriodIcon";
import { ScreenFrame } from "./ScreenFrame";

function periodOf(phase: string): "autonomous" | "driver" | null {
  if (phase === "countdown_autonomous" || phase === "autonomous") return "autonomous";
  if (phase === "countdown_driver" || phase === "driver") return "driver";
  return null;
}

/** The match clock, shared by the field display and the audience's In Match
 * screen, with each alliance's live total while the server sends one. */
export function InMatchView({ match, sessionId, now }: { match: LiveMatch; sessionId: number; now: number }) {
  const { t } = useTranslation();
  const teams = useTeamsById();
  const ranks = useRanks(sessionId, match.division_id);
  const fields = useFields(sessionId);
  const format = useMatchFormat();
  const fieldSetId = fields.data?.find((field) => field.id === match.field_id)?.field_set_id ?? null;
  const live = useLiveScores(fieldSetId);
  const remaining = remainingSeconds(match, now) ?? 0;
  const period = periodOf(match.phase);
  // Totals show only while the clock is on the match, whatever arrives: the
  // server clears them when the clock stops, but a draft change can race that.
  const clockRunning = match.phase !== "not_started" && match.phase !== "ended";
  const liveEntry = clockRunning ? live.matches.find((entry) => entry.match_id === match.id) : undefined;
  const liveScores = liveEntry ? new Map(liveEntry.alliances.map((row) => [row.alliance_id, row.score])) : null;

  let centre;
  if (match.phase === "ended") {
    centre = (
      <>
        <p className="clock" data-testid="clock">
          0:00
        </p>
        <p className="in-match__over">{t("display.matchOver")}</p>
      </>
    );
  } else if (match.phase === "awaiting_driver") {
    centre = <p className="clock clock--message">{t("display.driverNext")}</p>;
  } else if (COUNT_IN_PHASES.has(match.phase)) {
    centre = (
      <p className="clock clock--count-in" data-testid="count-in">
        {Math.max(1, Math.ceil(remaining - 1e-9))}
      </p>
    );
  } else {
    centre = (
      <p className="clock" data-testid="clock">
        {formatClock(remaining)}
      </p>
    );
  }

  return (
    <ScreenFrame title={matchTitle(t, match)} className="in-match">
      <ul className="in-match__chips">
        {match.alliances.flatMap((alliance) =>
          alliance.team_ids.map((teamId) => (
            <li key={`${alliance.id}-${teamId}`} className={`chip chip--${alliance.station}`} data-testid={`chip-${teamId}`}>
              <span className="chip__rank">{ranks?.get(teamId) ?? "–"}</span>
              <span className="chip__number">{teams?.get(teamId)?.number ?? ""}</span>
            </li>
          ))
        )}
      </ul>
      <div className="in-match__centre">
        {centre}
        {liveScores && format.data && (
          <div className="in-match__live">
            {allianceGroups(match, format.data.game_model).map((group) => (
              <p key={group.station} className={`live-total live-total--${group.station}`} data-testid={`live-${group.station}`}>
                <span className="live-total__score">{groupScore(group, liveScores) ?? 0}</span>
                <span className="live-total__tag">{t("display.live")}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      {match.paused && (
        <p className="in-match__paused" role="status">
          {t("display.paused")}
        </p>
      )}
      {period && match.phase !== "ended" && (
        <p className="in-match__banner">
          <PeriodIcon period={period} />
          {t(`display.period.${period}`)}
        </p>
      )}
    </ScreenFrame>
  );
}
