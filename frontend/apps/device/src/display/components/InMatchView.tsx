import { useTranslation } from "react-i18next";
import { COUNT_IN_PHASES, formatClock, remainingSeconds, type LiveMatch } from "@tournament-admin/shared";
import { useRanks, useTeamsById } from "../api";
import { matchTitle } from "../matchTitle";
import { PeriodIcon } from "./PeriodIcon";
import { ScreenFrame } from "./ScreenFrame";

function periodOf(phase: string): "autonomous" | "driver" | null {
  if (phase === "countdown_autonomous" || phase === "autonomous") return "autonomous";
  if (phase === "countdown_driver" || phase === "driver") return "driver";
  return null;
}

/** The match clock, shared by the field display and the audience's In Match screen. */
export function InMatchView({ match, sessionId, now }: { match: LiveMatch; sessionId: number; now: number }) {
  const { t } = useTranslation();
  const teams = useTeamsById();
  const ranks = useRanks(sessionId, match.division_id);
  const remaining = remainingSeconds(match, now) ?? 0;
  const period = periodOf(match.phase);

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
      <div className="in-match__centre">{centre}</div>
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
