import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead, SessionRead } from "../types";

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
  inline = false,
}: {
  initial: SessionFormValues;
  onSubmit: (values: SessionFormValues) => void;
  onCancel: () => void;
  submitLabel: string;
  isSaving: boolean;
  error: string | null;
  /** Inside a table row: the row already frames it, so skip the panel box. */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(initial);
  const timezones = listTimezones();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(values);
  }

  return (
    <form className={inline ? "panel--form" : "panel panel--form"} onSubmit={handleSubmit}>
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

  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
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
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("sessions.columnLabel")}</th>
              <th>{t("sessions.columnDate")}</th>
              <th className="table__col--detail">{t("sessions.columnTimezone")}</th>
              <th className="table__actions" />
            </tr>
          </thead>
          <tbody>
            {sessions?.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={4}>
                  {t("sessions.empty")}
                </td>
              </tr>
            )}
            {sessions?.map((session) =>
              editingId === session.id ? (
                <tr key={session.id} className="table__row--editing">
                  <td colSpan={4}>
                    <SessionForm
                      inline
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
                    <span className="table__title">
                      <Link to={`/sessions/${session.id}`}>{session.label}</Link>
                      {event?.active_session_id === session.id && (
                        <span className="badge badge-success">{t("sessions.activeBadge")}</span>
                      )}
                    </span>
                  </td>
                  <td className="table__nowrap">
                    {session.session_date ?? <span className="table__missing">—</span>}
                  </td>
                  <td className="table__secondary table__col--detail">
                    {session.timezone ?? <span className="table__missing">—</span>}
                  </td>
                  <td className="table__actions">
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setEditingId(session.id);
                        setCreating(false);
                      }}
                    >
                      {t("sessions.editAction")}
                    </button>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>

      {!creating && (
        <button
          className="btn"
          type="button"
          onClick={() => {
            setCreating(true);
            setEditingId(null);
          }}
        >
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
