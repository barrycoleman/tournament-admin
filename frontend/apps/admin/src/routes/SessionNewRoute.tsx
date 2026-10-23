import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { listTimezones } from "../orientation/timezones";
import { browserZone } from "../orientation/useOrientationData";
import type { SessionRead } from "../types";

export function SessionNewRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [zoneDefault] = useState(browserZone);
  const [label, setLabel] = useState("");
  const [sessionDate, setSessionDate] = useState("");
  const [timezone, setTimezone] = useState(zoneDefault);
  const timezones = listTimezones(zoneDefault);

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<SessionRead>("/api/sessions", {
        method: "POST",
        body: {
          label,
          session_date: sessionDate || null,
          timezone: timezone || null,
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
        <div className="field">
          <label className="field__label" htmlFor="session-label">
            {t("sessions.labelLabel")}
          </label>
          <input
            className="input"
            id="session-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="session-date">
            {t("sessions.dateLabel")}
          </label>
          <input
            className="input"
            id="session-date"
            type="date"
            value={sessionDate}
            onChange={(event) => setSessionDate(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="session-timezone">
            {t("sessions.timezoneLabel")}
          </label>
          <select
            className="select"
            id="session-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            <option value="">{t("sessions.noTimezoneOption")}</option>
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
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
