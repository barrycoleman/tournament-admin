import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SkillsRunPanel,
  apiRequest,
  formatClock,
  skillsClockActions,
  skillsClockPhase,
  skillsClockSeconds,
  type ScoringSocket,
  type SkillsClockAction,
  type SkillsClockState,
  type SkillsRun,
  type SkillsSet,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useScoresheetT } from "../skills/useScoresheetT";
import type { FieldSetRead, SessionSkillsType, SkillsAttemptRead, SkillsType, TeamSummary } from "../types";
import { StartRunDialog } from "./StartRunDialog";
import { lastFieldAttempt } from "./startRun";
import { useSkillsControlActions } from "./useSkillsControl";

type FieldRef = { id: number; name: string };

/** The phase label key: a paused running timer reads "paused". */
function phaseKey(timer: SkillsClockState, now: number): string {
  const phase = skillsClockPhase(timer, now);
  return phase === "running" && timer.paused ? "paused" : phase;
}

function rowStateKey(run: SkillsRun | null, last: SkillsAttemptRead | null, now: number): string {
  if (run) return phaseKey(run, now);
  return last ? "submitted" : "none";
}

function TimerButtons({
  timer,
  now,
  disabled,
  onAction,
}: {
  timer: SkillsClockState;
  now: number;
  disabled: boolean;
  onAction: (action: SkillsClockAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {skillsClockActions(timer, now).map((action) => (
        <button
          key={action}
          type="button"
          className={`btn btn-small${action === "start" || action === "resume" ? " btn-primary" : ""}`}
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {t(`skillsControl.action.${action}`)}
        </button>
      ))}
    </>
  );
}

/** One skills field set: its type, its shared timer, and a row per field. */
export function SkillsSetCard({
  sessionId,
  fieldSet,
  set,
  types,
  sessionTypes,
  teams,
  attempts,
  busyTeamIds,
  now,
  socketEvents,
}: {
  sessionId: number;
  fieldSet: FieldSetRead;
  set: SkillsSet;
  types: SkillsType[];
  sessionTypes: SessionSkillsType[];
  teams: TeamSummary[];
  attempts: SkillsAttemptRead[];
  busyTeamIds: Set<number>;
  now: number;
  /** Live events for the scoring panel (from useSkillsControlData). */
  socketEvents: ScoringSocket;
}) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const actions = useSkillsControlActions();
  const headingId = useId();
  const typeSelectId = useId();
  const scoreHeadingId = useId();
  const [starting, setStarting] = useState<FieldRef | null>(null);
  const [scoring, setScoring] = useState<FieldRef | null>(null);
  const [discarding, setDiscarding] = useState<(FieldRef & { teamNumber: string }) | null>(null);
  const hasRuns = set.fields.some((field) => field.run !== null);
  const typeLabel = (key: string) => types.find((type) => type.key === key)?.label ?? key;
  const runSeconds = (key: string) => types.find((type) => type.key === key)?.run_seconds ?? null;
  const teamNumber = (id: number) => teams.find((team) => team.id === id)?.number ?? "?";
  const failed = [actions.setTimer, actions.setType, actions.fieldTimer].find((mutation) => mutation.isError);
  const busy = actions.setTimer.isPending || actions.fieldTimer.isPending;

  return (
    <section className="panel skills-set" role="region" aria-labelledby={headingId}>
      <h2 id={headingId}>{fieldSet.name}</h2>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}
      <div className="skills-set__header">
        <div className="field">
          <label className="field__label" htmlFor={typeSelectId}>
            {t("skillsControl.typeLabel")}
          </label>
          <select
            id={typeSelectId}
            className="select"
            value={set.timer.skills_type ?? ""}
            disabled={hasRuns || actions.setType.isPending}
            onChange={(event) => actions.setType.mutate({ fieldSetId: fieldSet.id, skillsType: event.target.value })}
          >
            {types.map((type) => (
              <option key={type.key} value={type.key}>
                {type.label}
              </option>
            ))}
          </select>
          {hasRuns && <p className="field__hint">{t("skillsControl.typeLocked")}</p>}
        </div>
        <div className="skills-set__timer" role="group" aria-label={t("skillsControl.setTimer")}>
          <p className="match-control__clock" data-testid={`set-clock-${fieldSet.id}`}>
            {formatClock(skillsClockSeconds(set.timer, now, set.timer.run_seconds))}
          </p>
          <p>{t(`skillsControl.phase.${phaseKey(set.timer, now)}`)}</p>
          <div className="form-actions">
            <TimerButtons
              timer={set.timer}
              now={now}
              disabled={busy}
              onAction={(action) => actions.setTimer.mutate({ fieldSetId: fieldSet.id, action })}
            />
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t("skillsControl.columns.field")}</th>
              <th scope="col">{t("skillsControl.columns.team")}</th>
              <th scope="col">{t("skillsControl.columns.type")}</th>
              <th scope="col">{t("skillsControl.columns.timer")}</th>
              <th scope="col">{t("skillsControl.columns.state")}</th>
              <th scope="col" className="table__actions">
                {t("skillsControl.columns.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {set.fields.map((row) => {
              const run = row.run;
              const field = { id: row.field_id, name: row.name };
              const last = lastFieldAttempt(attempts, row.field_id);
              return (
                <tr key={row.field_id} aria-label={row.name}>
                  <th scope="row">{row.name}</th>
                  <td>
                    {run
                      ? `${run.team_number} ${run.team_name}`
                      : last
                        ? t("skillsControl.last", { number: teamNumber(last.team_id), score: last.score })
                        : "—"}
                  </td>
                  <td>{run ? typeLabel(run.skills_type) : "—"}</td>
                  <td className="table__nowrap">
                    {run
                      ? run.follows_set
                        ? t("skillsControl.followsSet")
                        : t("skillsControl.alone", {
                            clock: formatClock(skillsClockSeconds(run, now, runSeconds(run.skills_type))),
                          })
                      : "—"}
                  </td>
                  <td>{t(`skillsControl.state.${rowStateKey(run, last, now)}`)}</td>
                  <td className="table__actions">
                    {run ? (
                      <div className="skills-set__row-actions">
                        <button className="btn btn-small btn-primary" type="button" onClick={() => setScoring(field)}>
                          {t("skillsControl.score")}
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          type="button"
                          onClick={() => setDiscarding({ ...field, teamNumber: run.team_number })}
                        >
                          {t("skillsControl.discard")}
                        </button>
                        <div
                          className="form-actions"
                          role="group"
                          aria-label={t("skillsControl.fieldTimer", { name: row.name })}
                        >
                          <TimerButtons
                            timer={run}
                            now={now}
                            disabled={busy}
                            onAction={(action) =>
                              actions.fieldTimer.mutate({ fieldSetId: fieldSet.id, fieldId: row.field_id, action })
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <button className="btn btn-small" type="button" onClick={() => setStarting(field)}>
                        {t("skillsControl.startRun")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="field__hint">{t("skillsControl.fieldTimerHint")}</p>

      {starting && (
        <StartRunDialog
          sessionId={sessionId}
          fieldSetId={fieldSet.id}
          field={starting}
          setType={set.timer.skills_type}
          types={types}
          sessionTypes={sessionTypes}
          teams={teams}
          busyTeamIds={busyTeamIds}
          onClose={() => setStarting(null)}
        />
      )}
      {scoring && (
        <Modal labelledBy={scoreHeadingId} onCancel={() => setScoring(null)}>
          <h2 id={scoreHeadingId}>{t("skillsControl.scoreHeading", { name: scoring.name })}</h2>
          <SkillsRunPanel
            fieldId={scoring.id}
            fieldSetId={fieldSet.id}
            t={scoresheetT}
            myDeviceName="Admin"
            socketEvents={socketEvents}
            request={apiRequest}
            typeLabel={typeLabel}
          />
          <div className="dialog__actions">
            <button className="btn" type="button" onClick={() => setScoring(null)}>
              {t("skillsControl.close")}
            </button>
          </div>
        </Modal>
      )}
      {discarding && (
        <ConfirmDialog
          heading={t("skillsControl.discardHeading", { name: discarding.name })}
          body={t("skillsControl.discardBody", { number: discarding.teamNumber })}
          confirmLabel={t("skillsControl.discardConfirm")}
          cancelLabel={t("skillsControl.cancel")}
          isPending={actions.discard.isPending}
          error={actions.discard.isError ? apiErrorMessage(actions.discard.error, t("errors.generic")) : null}
          onConfirm={() =>
            actions.discard.mutate(
              { fieldSetId: fieldSet.id, fieldId: discarding.id },
              { onSuccess: () => setDiscarding(null) }
            )
          }
          onCancel={() => {
            actions.discard.reset();
            setDiscarding(null);
          }}
        />
      )}
    </section>
  );
}
