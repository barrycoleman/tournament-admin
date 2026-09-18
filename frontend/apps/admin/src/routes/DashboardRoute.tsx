import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { InlineEditableText } from "../components/InlineEditableText";
import type { EventRead } from "../types";

export function DashboardRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<EventRead>("/api/event", { method: "PATCH", body: { name } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["event"], updated);
    },
  });

  return (
    <div>
      <h1>{t("dashboard.heading")}</h1>
      {data && (
        <div className="panel panel--form">
          <div className="field">
            <span className="field__label">{t("dashboard.eventNameLabel")}</span>
            <InlineEditableText
              value={data.name}
              onSave={(name) => renameMutation.mutate(name)}
              onCancel={() => renameMutation.reset()}
              isSaving={renameMutation.isPending}
              error={
                renameMutation.isError
                  ? renameMutation.error instanceof ApiError
                    ? renameMutation.error.detail
                    : t("errors.generic")
                  : null
              }
              editLabel={t("dashboard.editEventNameAction")}
              saveLabel={t("dashboard.saveAction")}
              cancelLabel={t("dashboard.cancelAction")}
              inputLabel={t("dashboard.eventNameLabel")}
              inputId="event-name"
            />
          </div>
        </div>
      )}
    </div>
  );
}
