import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { SessionFormFields, type SessionFormValues } from "../sessions/SessionFormFields";
import { dateInZone, sessionZone } from "../orientation/sessionTime";
import { browserZone } from "../orientation/useOrientationData";
import type { SessionRead } from "../types";

/** Today's date (YYYY-MM-DD) in `zone`, or in `fallbackZone` for no zone or an unknown one. */
function todayIn(zone: string, fallbackZone: string): string {
  return dateInZone(new Date(), sessionZone({ timezone: zone } as SessionRead, fallbackZone));
}

export function SessionNewRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [zoneDefault] = useState(browserZone);
  const [values, setValues] = useState<SessionFormValues>(() => ({
    label: "",
    sessionDate: todayIn(zoneDefault, zoneDefault),
    timezone: zoneDefault,
    liveQualification: true,
    liveFinals: false,
  }));

  // The date starts as today in the chosen timezone and follows the zone
  // until the admin picks a date of their own.
  function handleChange(next: SessionFormValues) {
    const followsZone = values.sessionDate === todayIn(values.timezone, zoneDefault);
    if (next.timezone !== values.timezone && next.sessionDate === values.sessionDate && followsZone) {
      next = { ...next, sessionDate: todayIn(next.timezone, zoneDefault) };
    }
    setValues(next);
  }

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
        <SessionFormFields
          values={values}
          onChange={handleChange}
          autoFocus
          extraZone={zoneDefault}
          dateLabel={t("sessionNew.dateLabel")}
        />
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
