import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import type { QualificationPreview, SessionRead } from "../types";
import { draftFromRows, validateDraft } from "./finalizeDraft";

interface FinalizeDialogProps {
  sessionId: number;
  preview: QualificationPreview;
  onDone: (session: SessionRead) => void;
  onCancel: () => void;
}

export function FinalizeDialog({ sessionId, preview, onDone, onCancel }: FinalizeDialogProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [draft, setDraft] = useState(() => draftFromRows(preview.rows));
  const { drops, errors } = validateDraft(preview.rows, draft);
  const mutation = useMutation({
    mutationFn: (body: { drops: Record<string, number> }) =>
      apiRequest<SessionRead>(`/api/sessions/${sessionId}/qualification/finalize`, { method: "POST", body }),
    onSuccess: onDone,
  });
  const cooperative = preview.game_model === "cooperative_score";

  return (
    <Modal
      labelledBy={headingId}
      onCancel={() => {
        if (!mutation.isPending) onCancel();
      }}
    >
      <h2 id={headingId}>{t("sessions.qualification.dialogHeading")}</h2>
      <p>{t(cooperative ? "sessions.qualification.dialogIntro" : "sessions.qualification.dialogIntroHeadToHead")}</p>
      {preview.rows.map((row, index) => {
        const key = String(row.played);
        const errorId = `${headingId}-error-${key}`;
        return (
          <label key={key} className="field">
            <span className="field__label">
              {t("sessions.qualification.rowLabel", { played: row.played, count: row.teams })}
            </span>
            <input
              className="input"
              type="number"
              min={0}
              max={row.played - 1}
              step={1}
              value={draft[key]}
              data-autofocus={index === 0 ? true : undefined}
              aria-invalid={errors[key] ? true : undefined}
              aria-describedby={errorId}
              onChange={(e) => {
                setDraft((current) => ({ ...current, [key]: e.target.value }));
                mutation.reset();
              }}
            />
            <span id={errorId} className="field__hint" aria-live="polite">
              {errors[key] ? t("sessions.qualification.rowError", { max: errors[key].max }) : ""}
            </span>
          </label>
        );
      })}
      <p>{t("sessions.qualification.notPlayed", { count: preview.unplayed_matches })}</p>
      {mutation.error && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(mutation.error, t("sessions.qualification.genericError"))}
        </p>
      )}
      <div className="dialog__actions">
        <button type="button" className="btn btn-primary" disabled={drops === null || mutation.isPending} onClick={() => drops && mutation.mutate({ drops })}>
          {t("sessions.qualification.confirm")}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={mutation.isPending}>
          {t("sessions.qualification.cancel")}
        </button>
      </div>
    </Modal>
  );
}
