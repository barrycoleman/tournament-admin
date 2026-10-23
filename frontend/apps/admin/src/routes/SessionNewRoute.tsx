import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { SessionFormFields, type SessionFormValues } from "../sessions/SessionFormFields";
import { browserZone } from "../orientation/useOrientationData";
import type { SessionRead } from "../types";

export function SessionNewRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [zoneDefault] = useState(browserZone);
  const [values, setValues] = useState<SessionFormValues>({
    label: "",
    sessionDate: "",
    timezone: zoneDefault,
    liveQualification: true,
    liveFinals: false,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<SessionRead>("/api/sessions", {
        method: "POST",
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
        },
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/sessions/${created.id}/setup`);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <div>
      <h1>{t("sessionNew.heading")}</h1>
      <form className="panel panel--form" onSubmit={handleSubmit}>
        <SessionFormFields values={values} onChange={setValues} autoFocus extraZone={zoneDefault} />
        {createMutation.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(createMutation.error, t("errors.generic"))}
          </p>
        )}
        <div className="form-actions">
          <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
            {t("sessions.addSubmit")}
          </button>
        </div>
      </form>
    </div>
  );
}
