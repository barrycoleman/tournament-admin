import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { showTransientError } from "../errorBanner";
import { PreviewPanel } from "./PreviewPanel";
import {
  availableRoundTypes,
  buildScheduleRequest,
  defaultPhases,
  isCycleTimeTight,
  roundTypeOptionsForRow,
  todayInZone,
  type BlockDraft,
  type PhaseDraft,
  type ScheduleFormState,
  type ScheduleRequestPayload,
} from "./scheduleRequest";
import type { MatchFormat, PluginSummary, ScheduleGenerateResponse, SessionRead } from "../types";

interface ScheduleFormProps {
  sessionId: number;
  divisionId: number | null;
  session: SessionRead;
  matchFormat: MatchFormat;
  existingRoundTypes: string[];
  ready: boolean;
  onGenerated: (response: ScheduleGenerateResponse) => void;
}

export function ScheduleForm({
  sessionId,
  divisionId,
  session,
  matchFormat,
  existingRoundTypes,
  ready,
  onGenerated,
}: ScheduleFormProps) {
  const { t } = useTranslation();
  const available = useMemo(
    () => availableRoundTypes(matchFormat.round_types, existingRoundTypes),
    [matchFormat.round_types, existingRoundTypes]
  );
  const [state, setState] = useState<ScheduleFormState>(() => ({
    schedulerPluginName: "",
    phases: defaultPhases(available),
    timingMode: "fit",
    cycleMinutes: 7,
    blocks: [{ date: session.session_date ?? todayInZone(session.timezone), startTime: "09:00", endTime: "12:00" }],
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ response: ScheduleGenerateResponse; snapshot: string } | null>(null);

  const { data: schedulers } = useQuery({
    queryKey: ["plugins", "schedulers"],
    queryFn: () => apiRequest<PluginSummary[]>("/api/plugins/schedulers"),
  });
  const effectiveScheduler =
    state.schedulerPluginName ||
    (schedulers?.some((plugin) => plugin.name === "balanced") ? "balanced" : (schedulers?.[0]?.name ?? ""));
  const effectiveState: ScheduleFormState = { ...state, schedulerPluginName: effectiveScheduler };
  const snapshot = JSON.stringify(effectiveState);
  const stale = preview !== null && preview.snapshot !== snapshot;

  const submitMutation = useMutation({
    mutationFn: (payload: ScheduleRequestPayload) =>
      apiRequest<ScheduleGenerateResponse>("/api/schedule", { method: "POST", body: payload }),
    onError: (error) => {
      if (!(error instanceof ApiError)) showTransientError(t("errors.network"));
    },
  });

  function submit(dryRun: boolean) {
    const result = buildScheduleRequest(effectiveState, { sessionId, divisionId, dryRun });
    if (!result.ok) {
      setFormError(result.errorKey);
      return;
    }
    setFormError(null);
    const submittedSnapshot = snapshot;
    submitMutation.mutate(result.payload, {
      onSuccess: (response) => {
        if (dryRun) setPreview({ response, snapshot: submittedSnapshot });
        else onGenerated(response);
      },
    });
  }

  function update(patch: Partial<ScheduleFormState>) {
    setState((previous) => ({ ...previous, ...patch }));
  }
  function updatePhase(index: number, patch: Partial<PhaseDraft>) {
    update({ phases: state.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase)) });
  }
  function movePhase(index: number, offset: -1 | 1) {
    const phases = [...state.phases];
    [phases[index], phases[index + offset]] = [phases[index + offset], phases[index]];
    update({ phases });
  }
  function updateBlock(index: number, patch: Partial<BlockDraft>) {
    update({ blocks: state.blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)) });
  }

  const nextRoundType = available.find((roundType) => !state.phases.some((p) => p.roundType === roundType));
  const lastBlock = state.blocks[state.blocks.length - 1];
  const busy = submitMutation.isPending || available.length === 0;

  return (
    <section className="panel schedule-form" aria-label={t("sessions.schedule.form.heading")}>
      <h2>{t("sessions.schedule.form.heading")}</h2>

      {schedulers && schedulers.length === 0 ? (
        <p className="alert alert-danger">{t("sessions.schedule.form.noSchedulers")}</p>
      ) : (
        <label className="field">
          <span className="field__label">{t("sessions.schedule.form.schedulerLabel")}</span>
          <select
            className="select"
            value={effectiveScheduler}
            onChange={(event) => update({ schedulerPluginName: event.target.value })}
          >
            {(schedulers ?? []).map((plugin) => (
              <option key={plugin.name} value={plugin.name}>
                {plugin.display_name}
              </option>
            ))}
          </select>
        </label>
      )}

      {available.length === 0 && <p className="alert alert-warning">{t("sessions.schedule.form.noRoundTypes")}</p>}
      <fieldset className="schedule-form__group">
        <legend>{t("sessions.schedule.form.phasesHeading")}</legend>
        {state.phases.map((phase, index) => (
          <div key={index} className="form-actions">
            <select
              className="select"
              aria-label={t("sessions.schedule.form.phaseRoundTypeLabel", { n: index + 1 })}
              value={phase.roundType}
              onChange={(event) => updatePhase(index, { roundType: event.target.value })}
            >
              {roundTypeOptionsForRow(available, state.phases, index).map((roundType) => (
                <option key={roundType} value={roundType}>
                  {roundType}
                </option>
              ))}
            </select>
            <input
              className="input schedule-form__number"
              type="number"
              min={1}
              aria-label={t("sessions.schedule.form.phaseMatchesLabel", { n: index + 1 })}
              value={phase.matchesPerTeam}
              onChange={(event) => updatePhase(index, { matchesPerTeam: Number(event.target.value) })}
            />
            <button type="button" className="btn btn-small" disabled={index === 0} onClick={() => movePhase(index, -1)}>
              {t("sessions.schedule.form.moveUpAction")}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={index === state.phases.length - 1}
              onClick={() => movePhase(index, 1)}
            >
              {t("sessions.schedule.form.moveDownAction")}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={state.phases.length === 1}
              onClick={() => update({ phases: state.phases.filter((_, i) => i !== index) })}
            >
              {t("sessions.schedule.form.removePhaseAction")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-small"
          disabled={nextRoundType === undefined}
          onClick={() =>
            nextRoundType && update({ phases: [...state.phases, { roundType: nextRoundType, matchesPerTeam: 1 }] })
          }
        >
          {t("sessions.schedule.form.addPhaseAction")}
        </button>
      </fieldset>

      <fieldset className="schedule-form__group">
        <legend>{t("sessions.schedule.form.timingHeading")}</legend>
        <div className="form-actions">
          <label>
            <input
              type="radio"
              name="timing-mode"
              checked={state.timingMode === "fit"}
              onChange={() => update({ timingMode: "fit" })}
            />{" "}
            {t("sessions.schedule.form.timingFit")}
          </label>
          <label>
            <input
              type="radio"
              name="timing-mode"
              checked={state.timingMode === "fixed"}
              onChange={() => update({ timingMode: "fixed" })}
            />{" "}
            {t("sessions.schedule.form.timingFixed")}
          </label>
        </div>
        {state.timingMode === "fixed" && (
          <div className="field">
            <label className="field__label" htmlFor="schedule-cycle-minutes">
              {t("sessions.schedule.form.cycleMinutesLabel")}
            </label>
            <input
              id="schedule-cycle-minutes"
              className="input schedule-form__number"
              type="number"
              min={1}
              step={0.5}
              value={state.cycleMinutes}
              onChange={(event) => update({ cycleMinutes: Number(event.target.value) })}
            />
            <span className="field__hint">{t("sessions.schedule.form.fixedHint")}</span>
            {isCycleTimeTight(state.cycleMinutes, matchFormat.match_duration_seconds) && (
              <p className="alert alert-warning">
                {t("sessions.schedule.form.cycleTight", { seconds: matchFormat.match_duration_seconds })}
              </p>
            )}
          </div>
        )}
        {state.blocks.map((block, index) => (
          <div key={index} className="form-actions">
            <input
              className="input"
              type="date"
              aria-label={t("sessions.schedule.form.blockDateLabel", { n: index + 1 })}
              value={block.date}
              onChange={(event) => updateBlock(index, { date: event.target.value })}
            />
            <input
              className="input"
              type="time"
              aria-label={t("sessions.schedule.form.blockStartLabel", { n: index + 1 })}
              value={block.startTime}
              onChange={(event) => updateBlock(index, { startTime: event.target.value })}
            />
            <input
              className="input"
              type="time"
              aria-label={t("sessions.schedule.form.blockEndLabel", { n: index + 1 })}
              value={block.endTime}
              onChange={(event) => updateBlock(index, { endTime: event.target.value })}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={state.blocks.length === 1}
              onClick={() => update({ blocks: state.blocks.filter((_, i) => i !== index) })}
            >
              {t("sessions.schedule.form.removeBlockAction")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-small"
          onClick={() =>
            update({
              blocks: [
                ...state.blocks,
                { date: lastBlock.date, startTime: lastBlock.endTime || lastBlock.startTime, endTime: "" },
              ],
            })
          }
        >
          {t("sessions.schedule.form.addBlockAction")}
        </button>
      </fieldset>

      {formError && (
        <p className="alert alert-danger" role="alert">
          {t(formError)}
        </p>
      )}
      {submitMutation.error instanceof ApiError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(submitMutation.error, t("errors.generic"))}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn" disabled={!ready || busy || !effectiveScheduler} onClick={() => submit(true)}>
          {t("sessions.schedule.form.previewAction")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!ready || busy || !effectiveScheduler} onClick={() => submit(false)}>
          {t("sessions.schedule.form.generateAction")}
        </button>
      </div>
      {preview && <PreviewPanel response={preview.response} stale={stale} />}
    </section>
  );
}
