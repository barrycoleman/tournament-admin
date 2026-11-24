import { useTranslation } from "react-i18next";
import { COUNT_IN_PHASES, activeWindow, formatClock, remainingSeconds, type LiveMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useRanks, useTeamsById, type Team } from "../api";
import { groupScore, scoreGroups, sideGroups, type ScoreGroup } from "../logic/sides";
import { matchTitle } from "../matchTitle";
import { useLiveScores } from "../useLiveScores";
import { DriverChangeTag } from "./DriverChangeTag";
import { FitText } from "./FitText";
import { BottomBar, MatchFrame } from "./MatchFrame";
import { TeamBand } from "./TeamBand";

const NO_TEAMS = new Map<number, Team>();

function periodOf(phase: string): "autonomous" | "driver" | null {
  if (phase === "countdown_autonomous" || phase === "autonomous") return "autonomous";
  if (phase === "countdown_driver" || phase === "driver") return "driver";
  return null;
}

/** The match clock, shared by the field display and the audience's In Match
 * screen: the teams by side across the top, the clock filling the middle, and
 * the live totals either side of the match name in the bottom bar. */
export function InMatchView({ match, sessionId, now }: { match: LiveMatch; sessionId: number; now: number }) {
  const { t } = useTranslation();
  const teams = useTeamsById() ?? NO_TEAMS;
  // Ranks only decide the sides of a score-chase run; they are never shown here.
  const ranks = useRanks(sessionId, match.division_id);
  const fields = useFields(sessionId);
  const format = useMatchFormat();
  const field = fields.data?.find((row) => row.id === match.field_id);
  const live = useLiveScores(field?.field_set_id ?? null);
  const remaining = remainingSeconds(match, now) ?? 0;
  const period = periodOf(match.phase);
  // Totals show only while the clock is on the match, whatever arrives: the
  // server clears them when the clock stops, but a draft change can race that.
  const clockRunning = match.phase !== "not_started" && match.phase !== "ended";
  const liveEntry = clockRunning ? live.matches.find((entry) => entry.match_id === match.id) : undefined;
  const liveScores = liveEntry ? new Map(liveEntry.alliances.map((row) => [row.alliance_id, row.score])) : null;
  const groups = liveScores && format.data ? scoreGroups(match, format.data.game_model) : [];
  const total = (group: ScoreGroup | undefined, tagFirst = false) =>
    group && liveScores ? (
      <p className={`in-match-score in-match-score--${group.side}`} data-testid={`live-${group.side}`}>
        {tagFirst && <span className="in-match-score__tag">{t("display.live")}</span>}
        <span className="in-match-score__value">{groupScore(group, liveScores) ?? 0}</span>
        {!tagFirst && <span className="in-match-score__tag">{t("display.live")}</span>}
      </p>
    ) : null;
  const combined = groups.find((group) => group.side === "combined");
  const start = combined ? total(combined) : total(groups.find((group) => group.side === "red"));
  const end = total(groups.find((group) => group.side === "blue"), true);

  let clock;
  if (match.phase === "ended") {
    clock = <FitText className="in-match__clock" testId="clock">0:00</FitText>;
  } else if (match.phase === "awaiting_driver") {
    clock = <FitText className="in-match__message">{t("display.driverNext")}</FitText>;
  } else if (COUNT_IN_PHASES.has(match.phase)) {
    // The overlay below covers the screen; nothing to show under it.
    clock = null;
  } else {
    clock = <FitText className="in-match__clock" testId="clock">{formatClock(remaining)}</FitText>;
  }

  let under = null;
  if (match.phase === "ended") {
    under = <p className="in-match__over">{t("display.matchOver")}</p>;
  } else if (match.paused) {
    under = (
      <p className="in-match__paused-tag" role="status" data-testid="paused">
        {t("display.paused")}
      </p>
    );
  } else if (format.data && activeWindow(match.phase, remaining, format.data.moments ?? []) !== null) {
    under = <DriverChangeTag />;
  } else if (period) {
    under = (
      <p className="in-match__period" data-testid="period">
        {t(`display.period.${period}`)}
      </p>
    );
  }

  return (
    <MatchFrame
      className="in-match"
      bottom={<BottomBar title={matchTitle(t, match)} field={field?.name} start={start} end={end} />}
    >
      <div className="in-match__bands">
        {sideGroups(match, ranks).map((group) => (
          <TeamBand key={group.side} side={group.side} teamIds={group.teamIds} teams={teams} orientation="row" />
        ))}
      </div>
      <div className="in-match__centre">{clock}</div>
      <div className="in-match__under">{under}</div>
      {COUNT_IN_PHASES.has(match.phase) && (
        <div className="count-in-overlay" data-testid="count-in">
          <FitText className="count-in-overlay__number">{Math.max(1, Math.ceil(remaining - 1e-9))}</FitText>
        </div>
      )}
    </MatchFrame>
  );
}
