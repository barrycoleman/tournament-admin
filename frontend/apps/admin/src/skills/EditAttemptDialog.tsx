import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ScoresheetForm, type ScoresheetValues } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import type { SkillsAttemptRead, SkillsType } from "../types";
import { splitViolations } from "./scoresheetErrors";
import { skillsAttemptsKey, useSkillsSchema } from "./useSessionSkills";
import { useScoresheetT } from "./useScoresheetT";

/** An admin's correction: the attempt's scoresheet pre-filled, with Save, Cancel and Delete attempt. */
export function EditAttemptDialog({
  sessionId,
  attempt,
  type,
  teamNumber,
  onClose,
}: {
  sessionId: number;
  attempt: SkillsAttemptRead;
  type: SkillsType;
  teamNumber: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const schema = useSkillsSchema(attempt.skills_type);
  const [values, setValues] = useState<ScoresheetValues>(attempt.data);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function refreshAndClose() {
    queryClient.invalidateQueries({ queryKey: skillsAttemptsKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
    onClose();
  }

  const save = useMutation({
    mutationFn: (data: ScoresheetValues) =>
      apiRequest<SkillsAttemptRead>(`/api/skills/attempts/${attempt.id}`, { method: "PUT", body: { data } }),
    onSuccess: refreshAndClose,
  });
  const remove = useMutation({
    mutationFn: () => apiRequest<void>(`/api/skills/attempts/${attempt.id}`, { method: "DELETE" }),
    onSuccess: refreshAndClose,
  });
  const split = splitViolations(
    save.error,
    (schema.data ?? []).map((field) => field.name)
  );

  if (confirmingDelete) {
    return (
      <ConfirmDialog
        heading={t("skills.edit.deleteHeading")}
        body={t("skills.edit.deleteBody", { number: teamNumber, label: type.label })}
        confirmLabel={t("skills.edit.deleteConfirm")}
        cancelLabel={t("skills.edit.deleteCancel")}
        isPending={remove.isPending}
        error={remove.isError ? apiErrorMessage(remove.error, t("errors.generic")) : null}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          remove.reset();
          setConfirmingDelete(false);
        }}
      />
    );
  }

  return (
    <Modal labelledBy={headingId} onCancel={onClose}>
      <h2 id={headingId}>{t("skills.edit.heading", { label: type.label, n: attempt.number, number: teamNumber })}</h2>
      {schema.data ? (
        <ScoresheetForm
          fields={schema.data}
          values={values}
          errors={split?.byField ?? {}}
          t={scoresheetT}
          idPrefix={`${headingId}-sheet`}
          onChange={(next) => {
            setValues(next);
            save.reset();
          }}
        />
      ) : (
        <p>{t("skills.page.loading")}</p>
      )}
      {save.isError && (!split || split.other.length > 0) && (
        <p className="alert alert-danger" role="alert">
          {split ? split.other.join(" ") : apiErrorMessage(save.error, t("errors.generic"))}
        </p>
      )}
      <div className="dialog__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!schema.data || save.isPending}
          onClick={() => save.mutate(values)}
        >
          {t("skills.edit.save")}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t("skills.edit.cancel")}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => setConfirmingDelete(true)}>
          {t("skills.edit.delete")}
        </button>
      </div>
    </Modal>
  );
}
