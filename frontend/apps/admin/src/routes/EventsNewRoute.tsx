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
    <main>
      <h1>{t("eventsNew.heading")}</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="event-name">{t("eventsNew.nameLabel")}</label>
          <input
            id="event-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="event-password">{t("eventsNew.passwordLabel")}</label>
          <input
            id="event-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={mutation.isError ? "event-create-error" : undefined}
          />
        </div>
        {mutation.isError && (
          <p id="event-create-error" role="alert">
            {mutation.error instanceof ApiError
              ? mutation.error.detail
              : t("errors.generic")}
          </p>
        )}
        <button type="submit" disabled={mutation.isPending}>
          {t("eventsNew.submit")}
        </button>
      </form>
    </main>
  );
}
