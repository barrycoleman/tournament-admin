import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api-client";
import { formatClock } from "../display/clock";
import { ScoresheetForm, defaultValues, type ScoresheetField, type ScoresheetTranslate } from "../scoresheet";
import { scoringPaths } from "./api";
import { useClockNow } from "./ClockControls";
import { useSkillsRun } from "./useLiveDraft";
import type { ScoringRequest, ScoringSocket, SkillsPhase, SkillsTimerAction } from "./types";

export interface SkillsRunPanelProps {
  fieldId: number;
  fieldSetId: number;
  t: ScoresheetTranslate;
  myDeviceName: string;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** A skills type's label (the plugin's), else its key is shown. */
  typeLabel?: (key: string) => string;
}

function timerSeconds(
  timer: { phase: SkillsPhase; deadline: string | null; paused: boolean; remaining_seconds: number | null },
  fullLength: number | null,
  now: number
): number {
  if (timer.phase === "ended") return 0;
  if (timer.paused || timer.deadline === null) return timer.remaining_seconds ?? fullLength ?? 0;
  return Math.max(0, (Date.parse(timer.deadline) - now) / 1000);
}

function TimerButtons({
  label,
  phase,
  paused,
  t,
  onAction,
}: {
  label: string;
  phase: SkillsPhase;
  paused: boolean;
  t: ScoresheetTranslate;
  onAction: (action: SkillsTimerAction) => void;
}) {
  return (
    <div className="form-actions" role="group" aria-label={label}>
      {phase === "ready" && (
        <button className="btn btn-primary" type="button" onClick={() => onAction("start")}>
          {t("scoring.clock.start")}
        </button>
      )}
      {phase === "running" &&
        (paused ? (
          <button className="btn btn-primary" type="button" onClick={() => onAction("resume")}>
            {t("scoring.clock.resume")}
          </button>
        ) : (
          <button className="btn" type="button" onClick={() => onAction("pause")}>
            {t("scoring.clock.pause")}
          </button>
        ))}
      {phase === "running" && (
        <button className="btn" type="button" onClick={() => onAction("end")}>
          {t("scoring.clock.end")}
        </button>
      )}
      {phase !== "ready" && (
        <button className="btn" type="button" onClick={() => onAction("reset")}>
          {t("scoring.clock.reset")}
        </button>
      )}
    </div>
  );
}

/** One skills field's run: team, type, the field's and the set's timers, the sheet, Submit and Discard. Key it by field id. */
export function SkillsRunPanel({
  fieldId,
  fieldSetId,
  t,
  myDeviceName,
  socketEvents,
  request,
  typeLabel = (key) => key,
}: SkillsRunPanelProps) {
  const [schema, setSchema] = useState<ScoresheetField[]>([]);
  const defaults = useMemo(() => defaultValues(schema), [schema]);
  const live = useSkillsRun({ fieldId, fieldSetId, myDeviceName, socketEvents, request, defaults });
  const now = useClockNow();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const skillsType = live.run?.skills_type ?? null;

  useEffect(() => {
    if (skillsType === null) return undefined;
    let cancelled = false;
    void (request ?? apiRequest)<ScoresheetField[]>(scoringPaths.skillsSchema(skillsType))
      .then((fields) => {
        if (!cancelled) setSchema(fields);
      })
      .catch(() => {
        // The sheet stays empty; the error banner of the next request explains more.
      });
    return () => {
      cancelled = true;
    };
  }, [skillsType, request]);

  const field = live.set?.fields.find((entry) => entry.field_id === fieldId);
  const title = field?.name ?? t("scoring.loading");
  const run = live.run;
  const timer = live.set?.timer ?? null;

  return (
    <section className="panel skills-run" role="region" aria-label={title}>
      <h2>{title}</h2>
      {live.offline && (
        <p className="alert alert-warning" role="status">
          {live.pending > 0 ? t("scoring.offline") : t("scoring.reconnecting")}
        </p>
      )}
      {live.error !== null && (
        <p className="alert alert-danger" role="alert">
          {live.error || t("scoring.error")}
        </p>
      )}
      {live.gone ? (
        <p role="status">{t("scoring.skills.gone")}</p>
      ) : live.loading ? (
        <p>{t("scoring.loading")}</p>
      ) : run === null ? (
        <>
          {live.saved && (
            <p className="alert alert-success" role="status">
              {t("scoring.skills.saved", {
                team: `${live.saved.team_number} ${live.saved.team_name}`,
                type: typeLabel(live.saved.skills_type),
                score: live.saved.score,
              })}
            </p>
          )}
          <p>{t("scoring.skills.noRun")}</p>
        </>
      ) : (
        <>
          <p className="skills-run__team">{`${run.team_number} ${run.team_name} · ${typeLabel(run.skills_type)}`}</p>
          <p className="clock-controls__clock" data-testid="skills-clock">
            {formatClock(timerSeconds(run, run.follows_set ? (timer?.run_seconds ?? null) : null, now))}
          </p>
          <p>
            {run.paused ? t("scoring.clock.paused") : t(`scoring.skills.phase.${run.phase}`)}
            {" · "}
            {run.follows_set ? t("scoring.skills.followsSet") : t("scoring.skills.alone")}
          </p>
          <TimerButtons
            label={t("scoring.skills.fieldTimer")}
            phase={run.phase}
            paused={run.paused}
            t={t}
            onAction={(action) => live.timerAction("field", action)}
          />
          {run.follows_set && timer && (
            <TimerButtons
              label={t("scoring.skills.setTimer")}
              phase={timer.phase}
              paused={timer.paused}
              t={t}
              onAction={(action) => live.timerAction("set", action)}
            />
          )}
          <p className="scoring__total">{t("scoring.scoreSoFar", { score: run.score })}</p>
          <ScoresheetForm
            fields={schema}
            values={{ ...defaults, ...run.data }}
            notes={Object.fromEntries(
              Object.entries(live.flashing).map(([key, device]) => [key, t("scoring.changedBy", { device })])
            )}
            t={t}
            idPrefix={`skills-${fieldId}`}
            onChange={(next) => {
              const current = { ...defaults, ...run.data };
              for (const entry of schema) {
                if (next[entry.name] !== current[entry.name]) live.setItem(entry.name, next[entry.name]);
              }
            }}
          />
          {live.violations && (
            <div className="alert alert-danger" role="alert">
              <p>{t("scoring.violationsHeading")}</p>
              <ul>
                {live.violations.flatMap((violation) => violation.messages).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
              <button className="btn btn-danger" type="button" disabled={live.submitting} onClick={() => live.submit(true)}>
                {t("scoring.submitAnyway")}
              </button>
            </div>
          )}
          <div className="form-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={live.pending > 0 || live.submitting || live.offline}
              onClick={() => live.submit()}
            >
              {live.submitting ? t("scoring.submitting") : t("scoring.submit")}
            </button>
            <button className="btn" type="button" onClick={() => setConfirmDiscard(true)}>
              {t("scoring.skills.discard")}
            </button>
          </div>
          {confirmDiscard && (
            <div className="clock-controls__confirm" role="group" aria-label={t("scoring.skills.discardHeading")}>
              <p>{t("scoring.skills.discardHeading")}</p>
              <div className="form-actions">
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => {
                    setConfirmDiscard(false);
                    live.discard();
                  }}
                >
                  {t("scoring.skills.discardNow")}
                </button>
                <button className="btn" type="button" onClick={() => setConfirmDiscard(false)}>
                  {t("scoring.clock.cancel")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
