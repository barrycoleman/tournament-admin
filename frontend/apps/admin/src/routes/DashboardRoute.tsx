import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export function DashboardRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [renameError, setRenameError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<EventRead>("/api/event", { method: "PATCH", body: { name } }),
    onSuccess: (updated) => {
      setRenameError(null);
      queryClient.setQueryData(["event"], updated);
    },
    onError: (err) => {
      setRenameError(err instanceof ApiError ? err.detail : t("errors.generic"));
    },
  });

  return (
    <div>
      <h1>{t("dashboard.heading")}</h1>
      {data && (
        <div className="panel panel--form">
          <div className="field">
            <label className="field__label" htmlFor="event-name">
              {t("dashboard.eventNameLabel")}
            </label>
            <input
              className="input"
              id="event-name"
              defaultValue={data.name}
              onBlur={(event) => {
                const newName = event.target.value;
                if (newName !== data.name) {
                  renameMutation.mutate(newName);
                }
              }}
            />
          </div>
          {renameError && (
            <p className="alert alert-danger" role="alert">
              {renameError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
