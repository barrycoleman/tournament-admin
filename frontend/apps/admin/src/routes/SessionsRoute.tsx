import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { SessionRead } from "../types";

function listTimezones(): string[] {
  const intlWithZones = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  return intlWithZones.supportedValuesOf?.("timeZone") ?? [];
}

interface SessionFormValues {
  label: string;
  sessionDate: string;
  timezone: string;
}

const EMPTY_FORM: SessionFormValues = { label: "", sessionDate: "", timezone: "" };

function SessionForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
  isSaving,
  error,
}: {
  initial: SessionFormValues;
  onSubmit: (values: SessionFormValues) => void;
  onCancel: () => void;
  submitLabel: string;
  isSaving: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(initial);
  const timezones = listTimezones();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(values);
  }

  return (
    <form className="panel panel--form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field__label" htmlFor="session-label">
          {t("sessions.labelLabel")}
        </label>
        <input
          className="input"
          id="session-label"
          value={values.label}
          onChange={(event) => setValues({ ...values, label: event.target.value })}
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
          value={values.sessionDate}
          onChange={(event) => setValues({ ...values, sessionDate: event.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="session-timezone">
          {t("sessions.timezoneLabel")}
        </label>
        <select
          className="select"
          id="session-timezone"
          value={values.timezone}
          onChange={(event) => setValues({ ...values, timezone: event.target.value })}
        >
          <option value="">{t("sessions.noTimezoneOption")}</option>
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={isSaving}>
          {submitLabel}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={isSaving}>
          {t("sessions.cancelAction")}
        </button>
      </div>
    </form>
  );
}

export function SessionsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });

  const createMutation = useMutation({
    mutationFn: (values: SessionFormValues) =>
      apiRequest<SessionRead>("/api/sessions", {
        method: "POST",
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
        },
      }),
    onSuccess: () => {
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: number; values: SessionFormValues }) =>
      apiRequest<SessionRead>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
        },
      }),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  return (
    <div>
      <h1>{t("sessions.heading")}</h1>
      <table className="table">
        <thead>
          <tr>
            <th>{t("sessions.columnLabel")}</th>
            <th>{t("sessions.columnDate")}</th>
            <th>{t("sessions.columnTimezone")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions?.map((session) =>
            editingId === session.id ? (
              <tr key={session.id}>
                <td colSpan={4}>
                  <SessionForm
                    initial={{
                      label: session.label,
                      sessionDate: session.session_date ?? "",
                      timezone: session.timezone ?? "",
                    }}
                    onSubmit={(values) => updateMutation.mutate({ id: session.id, values })}
                    onCancel={() => {
                      setEditingId(null);
                      updateMutation.reset();
                    }}
                    submitLabel={t("sessions.saveAction")}
                    isSaving={updateMutation.isPending && updateMutation.variables?.id === session.id}
                    error={
                      updateMutation.isError && updateMutation.variables?.id === session.id
                        ? updateMutation.error instanceof ApiError
                          ? updateMutation.error.detail
                          : t("errors.generic")
                        : null
                    }
                  />
                </td>
              </tr>
            ) : (
              <tr key={session.id}>
                <td>
                  <Link to={`/sessions/${session.id}`}>{session.label}</Link>
                </td>
                <td>{session.session_date ?? "—"}</td>
                <td>{session.timezone ?? "—"}</td>
                <td>
                  <button className="btn btn-small" onClick={() => setEditingId(session.id)}>
                    {t("sessions.editAction")}
                  </button>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      {!creating && (
        <button className="btn" type="button" onClick={() => setCreating(true)}>
          {t("sessions.addSessionAction")}
        </button>
      )}
      {creating && (
        <SessionForm
          initial={EMPTY_FORM}
          onSubmit={(values) => createMutation.mutate(values)}
          onCancel={() => {
            setCreating(false);
            createMutation.reset();
          }}
          submitLabel={t("sessions.addSubmit")}
          isSaving={createMutation.isPending}
          error={
            createMutation.isError
              ? createMutation.error instanceof ApiError
                ? createMutation.error.detail
                : t("errors.generic")
              : null
          }
        />
      )}
    </div>
  );
}
