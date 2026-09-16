import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export function EventsNewRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<EventRead>("/api/event", {
        method: "POST",
        body: { name, password },
      }),
    onSuccess: () => navigate("/login", { replace: true }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>{t("eventsNew.heading")}</h1>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="event-name">
              {t("eventsNew.nameLabel")}
            </label>
            <input
              className="input"
              id="event-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="event-password">
              {t("eventsNew.passwordLabel")}
            </label>
            <input
              className="input"
              id="event-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={mutation.isError ? "event-create-error" : undefined}
            />
          </div>
          {mutation.isError && (
            <p className="alert alert-danger" id="event-create-error" role="alert">
              {mutation.error instanceof ApiError ? mutation.error.detail : t("errors.generic")}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={mutation.isPending}>
              {t("eventsNew.submit")}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
