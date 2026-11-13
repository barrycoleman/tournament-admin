import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { browserZone } from "../orientation/useOrientationData";
import type { SessionRead } from "../types";
import { SessionFormFields, type SessionFormValues } from "./SessionFormFields";

/** Edits one session's name, date, timezone and live-score switches in place. */
export function SessionSettingsForm({ session }: { session: SessionRead }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const suggested = session.timezone === null;
  const [initialZone] = useState(() => session.timezone ?? browserZone());
  const [values, setValues] = useState<SessionFormValues>(() => ({
    label: session.label,
    sessionDate: session.session_date ?? "",
    timezone: initialZone,
    liveQualification: session.live_scores_qualification ?? true,
    liveFinals: session.live_scores_finals ?? false,
  }));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      apiRequest<SessionRead>(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
          live_scores_qualification: values.liveQualification,
          live_scores_finals: values.liveFinals,
        },
      }),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className="panel panel--form" onSubmit={handleSubmit}>
      <SessionFormFields
        values={values}
        onChange={(next) => {
          setSaved(false);
          setValues(next);
        }}
        showLiveSwitches
        extraZone={initialZone}
        timezoneHint={suggested && !saved && values.timezone === initialZone ? t("sessions.setup.timezoneSuggested") : undefined}
      />
      {save.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(save.error, t("errors.generic"))}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {t("sessions.saveAction")}
        </button>
        {saved && <span role="status">{t("sessions.setup.saved")}</span>}
      </div>
    </form>
  );
}
