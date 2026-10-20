import { useEffect, useState } from "react";
import { formatClock, remainingSeconds } from "../display/clock";
import type { LiveMatch } from "../display/types";
import type { ScoresheetTranslate } from "../scoresheet";
import type { MatchClockAction, ScoringMatchFormat } from "./types";

/** Phases a segment reset applies to; the server refuses it elsewhere. */
const SECTION_PHASES = new Set(["countdown_autonomous", "autonomous", "countdown_driver", "driver"]);

export type ClockMatch = Pick<
  LiveMatch,
  "id" | "phase" | "phase_deadline" | "paused" | "remaining_seconds_at_pause" | "status"
>;

export interface ClockControlsProps {
  match: ClockMatch;
  matchFormat: ScoringMatchFormat;
  t: ScoresheetTranslate;
  onAction: (action: MatchClockAction, body?: { scope: "section" | "full" }) => void;
  /** Disables the buttons while an action is on its way. */
  busy?: boolean;
}

/** A readable fallback for an enum value with no translation: "countdown_driver" -> "Countdown driver". Never a raw key. */
export function humanize(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function useClockNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** True when the match has an autonomous part and a driver part. */
export function isTwoPart(format: ScoringMatchFormat): boolean {
  return format.autonomous_seconds > 0 && format.driver_seconds > 0;
}

function clockText(match: ClockMatch, format: ScoringMatchFormat, now: number): string {
  if (match.phase === "ended") return formatClock(0);
  if (match.phase === "not_started") {
    return formatClock(format.autonomous_seconds > 0 ? format.autonomous_seconds : format.driver_seconds);
  }
  if (match.phase === "awaiting_driver") return formatClock(format.driver_seconds);
  return formatClock(remainingSeconds(match, now) ?? 0);
}

/** A match's clock with Start / Start driver, Pause / Resume, Reset timer and End, as a scorer or the admin runs it. */
export function ClockControls({ match, matchFormat, t, onAction, busy = false }: ClockControlsProps) {
  const now = useClockNow();
  const [confirming, setConfirming] = useState<"end" | "reset" | null>(null);
  const finished = match.status === "completed" || match.status === "not_played";
  const running = match.phase !== "not_started" && match.phase !== "ended";
  const act = (action: MatchClockAction, body?: { scope: "section" | "full" }) => {
    setConfirming(null);
    onAction(action, body);
  };

  return (
    <section className="clock-controls" role="region" aria-label={t("scoring.clock.heading")}>
      <p className="clock-controls__clock" data-testid="scoring-clock">
        {clockText(match, matchFormat, now)}
      </p>
      <p className="clock-controls__phase">
        {match.paused ? t("scoring.clock.paused") : t(`scoring.phase.${match.phase}`, { defaultValue: humanize(match.phase) })}
      </p>
      {!finished && (
        <div className="form-actions">
          {match.phase === "not_started" && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act("start")}>
              {t("scoring.clock.start")}
            </button>
          )}
          {match.phase === "awaiting_driver" && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act("start-driver")}>
              {t("scoring.clock.startDriver")}
            </button>
          )}
          {SECTION_PHASES.has(match.phase) &&
            (match.paused ? (
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act("resume")}>
                {t("scoring.clock.resume")}
              </button>
            ) : (
              <button className="btn" type="button" disabled={busy} onClick={() => act("pause")}>
                {t("scoring.clock.pause")}
              </button>
            ))}
          {match.phase !== "not_started" && (
            <button className="btn" type="button" disabled={busy} onClick={() => setConfirming("reset")}>
              {t("scoring.clock.reset")}
            </button>
          )}
          {running && (
            <button className="btn btn-danger" type="button" disabled={busy} onClick={() => setConfirming("end")}>
              {t("scoring.clock.end")}
            </button>
          )}
        </div>
      )}
      {confirming === "end" && (
        <div className="clock-controls__confirm" role="group" aria-label={t("scoring.clock.endHeading")}>
          <p>{t("scoring.clock.endHeading")}</p>
          <div className="form-actions">
            <button className="btn btn-danger" type="button" onClick={() => act("end")}>
              {t("scoring.clock.endNow")}
            </button>
            <button className="btn" type="button" onClick={() => setConfirming(null)}>
              {t("scoring.clock.cancel")}
            </button>
          </div>
        </div>
      )}
      {confirming === "reset" && (
        <div className="clock-controls__confirm" role="group" aria-label={t("scoring.clock.resetHeading")}>
          <p>{t("scoring.clock.resetHeading")}</p>
          <div className="form-actions">
            {isTwoPart(matchFormat) && SECTION_PHASES.has(match.phase) && (
              <button className="btn" type="button" onClick={() => act("reset", { scope: "section" })}>
                {t("scoring.clock.resetSegment")}
              </button>
            )}
            <button className="btn btn-danger" type="button" onClick={() => act("reset", { scope: "full" })}>
              {t("scoring.clock.resetMatch")}
            </button>
            <button className="btn" type="button" onClick={() => setConfirming(null)}>
              {t("scoring.clock.cancel")}
            </button>
          </div>
          <p className="field__hint">{t("scoring.clock.resetWarning")}</p>
        </div>
      )}
    </section>
  );
}
