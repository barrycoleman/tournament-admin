import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export function DashboardRoute() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });

  return (
    <div>
      <h1>{t("dashboard.heading")}</h1>
      {data && (
        <p>
          {t("dashboard.eventNameLabel")}: {data.name}
        </p>
      )}
    </div>
  );
}
