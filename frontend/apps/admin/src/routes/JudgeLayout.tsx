import { Outlet } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import type { EventRead, SessionRead } from "../types";

const CHANNEL = "/ws/active-session";

/** The judge's pages always show the event's active session. */
export function JudgeLayout() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const event = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => apiRequest<SessionRead[]>("/api/sessions") });
  useRealtimeChannel({
    path: CHANNEL,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "active_session_changed") {
        queryClient.invalidateQueries({ queryKey: ["event"] });
      }
    },
  });
  if (event.isLoading || sessions.isLoading) return <p>{t("judge.loading")}</p>;
  const session = sessions.data?.find((s) => s.id === event.data?.active_session_id);
  if (!session) return <p>{t("judge.noActiveSession")}</p>;
  return (
    <div>
      <h1>{session.label}</h1>
      <Outlet context={{ session, channelPath: CHANNEL }} />
    </div>
  );
}
