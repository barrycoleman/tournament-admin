import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { showTransientError } from "../errorBanner";
import { roundTypeLabel } from "../roundTypeLabel";
import { ClearRoundDialog } from "./ClearRoundDialog";
import { FitStatus } from "./FitStatus";
import { PlanTimeline } from "./PlanTimeline";
import { PlayingTimesPanel } from "./PlayingTimesPanel";
import { RoundsTable } from "./RoundsTable";
import {
  buildPlanRequest,
  formatCycle,
  planAction,
  plannerRoundTypes,
  rowsToSend,
  rowsValid,
  type PlanRequest,
} from "./planDraft";
import { withLastWindowEnd } from "./playingWindows";
import type { TimelineSpan } from "./timeline";
import { usePlannerDraft } from "./usePlannerDraft";
import { usePlanPreview } from "./usePlanPreview";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";
import type {
  MatchFormat,
  PlanResponse,
  PlayingWindowRead,
  PluginSummary,
  ScheduledRound,
  ScheduleRounds,
  SessionRead,
} from "../types";

interface DivisionPlannerProps {
  session: SessionRead;
  divisionId: number | null;
  matchFormat: MatchFormat;
  windows: PlayingWindowRead[];
  ready: boolean;
  /** When the session's matches last changed, so the rounds refresh with them. */
  matchesUpdatedAt: number;
  onDirtyChange: (dirty: boolean) => void;
}

export function DivisionPlanner({
  session,
  divisionId,
  matchFormat,
  windows,
  ready,
  matchesUpdatedAt,
  onDirtyChange,
}: DivisionPlannerProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [clearTargets, setClearTargets] = useState<ScheduledRound[] | null>(null);
  const [applied, setApplied] = useState<PlanResponse | null>(null);
  const [schedulerChoice, setSchedulerChoice] = useState("");

  const params = new URLSearchParams({ session_id: String(session.id) });
  if (divisionId !== null) params.set("division_id", String(divisionId));
  const roundsQuery = useQuery({
    queryKey: ["scheduleRounds", session.id, divisionId],
    queryFn: () => apiRequest<ScheduleRounds>(`/api/schedule/rounds?${params.toString()}`),
  });
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
  }, [matchesUpdatedAt, queryClient, session.id]);

  const { data: schedulers } = useQuery({
    queryKey: ["plugins", "schedulers"],
    queryFn: () => apiRequest<PluginSummary[]>("/api/plugins/schedulers"),
  });
  const schedulerPluginName =
    schedulerChoice ||
    (schedulers?.some((plugin) => plugin.name === "balanced") ? "balanced" : (schedulers?.[0]?.name ?? ""));

  const draft = usePlannerDraft(roundsQuery.data, matchFormat);
  const toSend = rowsToSend(draft.rows);
  const action = planAction(draft.rows);
  const valid = rowsValid(toSend, matchFormat.match_duration_seconds);
  const dirty = draft.dirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const guardDialog = useUnsavedChangesGuard(dirty);

  const context = { sessionId: session.id, divisionId, schedulerPluginName };
  const previewRequest =
    ready && action !== "none" && valid && schedulerPluginName
      ? buildPlanRequest(toSend, { ...context, dryRun: true })
      : null;
  const preview = usePlanPreview(previewRequest);

  const apply = useMutation({
    mutationFn: (body: PlanRequest) => apiRequest<PlanResponse>("/api/schedule", { method: "POST", body }),
    onSuccess: (response) => {
      setApplied(response);
      queryClient.invalidateQueries({ queryKey: ["matches", session.id] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) showTransientError(t("errors.network"));
    },
  });
  const extend = useMutation({
    mutationFn: (endTime: string) =>
      apiRequest(`/api/sessions/${session.id}/playing-windows`, { method: "PUT", body: withLastWindowEnd(windows, endTime) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playingWindows", session.id] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) showTransientError(t("errors.network"));
    },
  });

  const sendKeys = new Set(toSend.map((row) => row.key));
  const spans: TimelineSpan[] = [
    ...draft.rows
      .filter((row) => row.scheduled?.first_start && row.scheduled.last_end && !sendKeys.has(row.key))
      .map((row) => ({
        kind: "scheduled" as const,
        roundType: row.roundType,
        startMs: Date.parse(row.scheduled!.first_start!),
        endMs: Date.parse(row.scheduled!.last_end!),
      })),
    ...(preview.data?.rounds ?? [])
      .filter((round) => round.first_start)
      .map((round) => ({
        kind: "draft" as const,
        roundType: round.round_type,
        startMs: Date.parse(round.first_start!),
        endMs: round.last_end ? Date.parse(round.last_end) : Number.POSITIVE_INFINITY,
      })),
  ];
  const scheduledRounds = roundsQuery.data?.rounds ?? [];
  const primaryDisabled =
    !ready ||
    action === "none" ||
    !valid ||
    !schedulerPluginName ||
    !preview.settled ||
    !preview.data?.fits ||
    apply.isPending ||
    roundsQuery.isFetching;

  return (
    <>
      <PlayingTimesPanel
        session={session}
        windows={windows}
        outsideRounds={scheduledRounds
          .filter((round) => round.outside_playing_windows)
          .map((round) => ({ roundType: round.round_type, locked: round.locked }))}
        timeline={
          <PlanTimeline windows={windows} spans={spans} overBySeconds={preview.data?.overflow?.over_by_seconds ?? 0} />
        }
      />
      {draft.dropped.length > 0 && (
        <p className="alert alert-warning" role="status">
          {t("sessions.schedule.rounds.droppedLocked", {
            rounds: draft.dropped.map((type) => roundTypeLabel(t, type)).join(", "),
          })}
        </p>
      )}
      <section className="panel" aria-labelledby={headingId}>
        <h2 id={headingId}>{t("sessions.schedule.rounds.heading")}</h2>
        {roundsQuery.isError ? (
          <p className="alert alert-danger" role="alert">
            {t("errors.generic")}
          </p>
        ) : draft.loaded && (
          <RoundsTable
            rows={draft.rows}
            sendKeys={sendKeys}
            preview={preview.data}
            timeZone={session.timezone}
            availableTypes={plannerRoundTypes(matchFormat.round_types)}
            onRowsChange={draft.setRows}
            onClear={(round) => setClearTargets([round])}
            cycleFor={draft.cycleFor}
            nextKey={draft.nextKey}
          />
        )}
        {scheduledRounds.length > 1 && (
          <button type="button" className="btn btn-danger btn-small" onClick={() => setClearTargets(scheduledRounds)}>
            {t("sessions.schedule.rounds.clearAllAction")}
          </button>
        )}
        {action !== "none" && !valid && (
          <p className="alert alert-warning" role="status">
            {t("sessions.schedule.rounds.invalid", { cycle: formatCycle(matchFormat.match_duration_seconds) })}
          </p>
        )}
        {previewRequest !== null && (
          <FitStatus
            preview={preview}
            windows={windows}
            extendPending={extend.isPending}
            onUseCycle={(seconds) => {
              const lastKey = toSend[toSend.length - 1].key;
              draft.setRows(draft.rows.map((row) => (row.key === lastKey ? { ...row, cycleSeconds: seconds } : row)));
            }}
            onExtend={(endTime) => extend.mutate(endTime)}
          />
        )}
        {extend.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(extend.error, t("errors.generic"))}
          </p>
        )}
        {apply.error instanceof ApiError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(apply.error, t("errors.generic"))}
          </p>
        )}
        {schedulers && schedulers.length === 0 && (
          <p className="alert alert-danger">{t("sessions.schedule.noSchedulers")}</p>
        )}
        <div className="form-actions">
          {action === "apply" && (
            <span className="field__hint">
              {t("sessions.schedule.actions.rebuilds", {
                rounds: toSend.filter((row) => row.scheduled).map((row) => roundTypeLabel(t, row.roundType)).join(", "),
              })}
            </span>
          )}
          {dirty && (
            <button type="button" className="btn" onClick={draft.discard}>
              {t("sessions.schedule.actions.discard")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={primaryDisabled}
            onClick={() => apply.mutate(buildPlanRequest(toSend, { ...context, dryRun: false }))}
          >
            {action === "apply" ? t("sessions.schedule.actions.apply") : t("sessions.schedule.actions.generate")}
          </button>
        </div>
        {applied && (
          <p className="alert alert-success" role="status">
            {t("sessions.schedule.actions.applied", {
              count: applied.rounds.reduce((sum, round) => sum + round.match_count, 0),
            })}{" "}
            <Link to={`/sessions/${session.id}/matches`}>{t("sessions.schedule.actions.viewMatches")}</Link>
          </p>
        )}
        <details className="schedule-form__more">
          <summary>{t("sessions.schedule.actions.moreOptions")}</summary>
          <label className="field">
            <span className="field__label">{t("sessions.schedule.actions.schedulerLabel")}</span>
            <select
              className="select"
              value={schedulerPluginName}
              onChange={(event) => setSchedulerChoice(event.target.value)}
            >
              {(schedulers ?? []).map((plugin) => (
                <option key={plugin.name} value={plugin.name}>
                  {plugin.display_name}
                </option>
              ))}
            </select>
          </label>
        </details>
      </section>
      {clearTargets && (
        <ClearRoundDialog
          key={clearTargets.map((round) => round.round_type).join(",")}
          sessionId={session.id}
          divisionId={divisionId}
          targets={clearTargets}
          onDone={() => setClearTargets(null)}
        />
      )}
      {guardDialog}
    </>
  );
}
