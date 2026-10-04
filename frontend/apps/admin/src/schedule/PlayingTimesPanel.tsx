import { useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { roundTypeLabel } from "../roundTypeLabel";
import {
  draftsFromWindows,
  nextWindowDraft,
  summarizeWindows,
  todayInZone,
  validateWindowDrafts,
  windowsPayload,
  type WindowDraft,
} from "./playingWindows";
import type { PlayingWindowRead, SessionRead } from "../types";

interface PlayingTimesPanelProps {
  session: SessionRead;
  windows: PlayingWindowRead[];
  timeline: ReactNode;
  outsideRounds: { roundType: string; locked: boolean }[];
}

/** The session's playing windows: a one-line summary and timeline, or an editor. */
export function PlayingTimesPanel({ session, windows, timeline, outsideRounds }: PlayingTimesPanelProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const today = todayInZone(session.timezone);
  const [drafts, setDrafts] = useState<WindowDraft[] | null>(
    windows.length === 0 ? [nextWindowDraft([], session.session_date, today)] : null
  );
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof windowsPayload>) =>
      apiRequest<PlayingWindowRead[]>(`/api/sessions/${session.id}/playing-windows`, { method: "PUT", body }),
    onSuccess: () => {
      setDrafts(null);
      queryClient.invalidateQueries({ queryKey: ["playingWindows", session.id] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
  });

  function submit() {
    if (drafts === null) return;
    const error = validateWindowDrafts(drafts);
    if (error) {
      setProblem(t(`sessions.schedule.playingTimes.errors.${error}`));
      return;
    }
    setProblem(null);
    save.mutate(windowsPayload(drafts));
  }

  function updateDraft(index: number, patch: Partial<WindowDraft>) {
    setDrafts((current) => current!.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  const rebuild = outsideRounds.filter((r) => !r.locked).map((r) => roundTypeLabel(t, r.roundType));
  const locked = outsideRounds.filter((r) => r.locked).map((r) => roundTypeLabel(t, r.roundType));

  return (
    <section id="playing-times" className="panel playing-times" aria-labelledby={headingId}>
      <div className="playing-times__header">
        <h2 id={headingId}>{t("sessions.schedule.playingTimes.heading")}</h2>
        {drafts === null && (
          <>
            <span className="playing-times__summary">
              {windows.length > 0 ? summarizeWindows(windows, i18n.language) : t("sessions.schedule.playingTimes.none")}
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                save.reset();
                setDrafts(draftsFromWindows(windows));
              }}
            >
              {t("sessions.schedule.playingTimes.edit")}
            </button>
          </>
        )}
      </div>

      {drafts === null ? (
        timeline
      ) : (
        <div className="playing-times__editor">
          {windows.length === 0 && <p className="field__hint">{t("sessions.schedule.playingTimes.none")}</p>}
          {drafts.map((draft, index) => (
            <div key={index} className="form-actions">
              <input
                className="input"
                type="date"
                aria-label={t("sessions.schedule.playingTimes.dateLabel", { n: index + 1 })}
                value={draft.date}
                onChange={(event) => updateDraft(index, { date: event.target.value })}
              />
              <input
                className="input"
                type="time"
                aria-label={t("sessions.schedule.playingTimes.startLabel", { n: index + 1 })}
                value={draft.startTime}
                onChange={(event) => updateDraft(index, { startTime: event.target.value })}
              />
              <input
                className="input"
                type="time"
                aria-label={t("sessions.schedule.playingTimes.endLabel", { n: index + 1 })}
                value={draft.endTime}
                onChange={(event) => updateDraft(index, { endTime: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-small"
                aria-label={t("sessions.schedule.playingTimes.removeLabel", { n: index + 1 })}
                onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
              >
                {t("sessions.schedule.playingTimes.remove")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small schedule-form__add"
            onClick={() => setDrafts([...drafts, nextWindowDraft(drafts, session.session_date, today)])}
          >
            {t("sessions.schedule.playingTimes.add")}
          </button>
          {problem && (
            <p className="alert alert-danger" role="alert">
              {problem}
            </p>
          )}
          {save.isError && (
            <p className="alert alert-danger" role="alert">
              {apiErrorMessage(save.error, t("errors.generic"))}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
              {t("sessions.schedule.playingTimes.save")}
            </button>
            {windows.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDrafts(null);
                  setProblem(null);
                }}
              >
                {t("sessions.schedule.playingTimes.cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      {rebuild.length > 0 && (
        <p className="alert alert-warning">
          {t("sessions.schedule.playingTimes.outsideRebuild", { rounds: rebuild.join(", ") })}
        </p>
      )}
      {locked.length > 0 && (
        <p className="alert alert-warning">
          {t("sessions.schedule.playingTimes.outsideLocked", { rounds: locked.join(", ") })}
        </p>
      )}
    </section>
  );
}
