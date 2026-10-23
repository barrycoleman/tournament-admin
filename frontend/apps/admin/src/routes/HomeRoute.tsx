import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { checkEventSetup, type EventSetupKey } from "../orientation/readiness";
import { pickLandingSession } from "../orientation/sessionTime";
import {
  browserZone,
  useEvent,
  useSessions,
  useSessionWindows,
} from "../orientation/useOrientationData";
import type { TeamSummary } from "../types";

const ITEM_TARGETS: Record<EventSetupKey, string> = {
  gamePlugin: "/events/setup#game-plugins",
  teams: "/teams",
  session: "/sessions/new",
};

export function HomeRoute() {
  const { t } = useTranslation();
  const { data: event } = useEvent();
  const { data: sessions } = useSessions();
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const { windowsById, isLoading: windowsLoading } = useSessionWindows(
    (sessions ?? []).map((s) => s.id)
  );

  if (!event || !sessions || !teams || windowsLoading) {
    return <p>{t("home.loading")}</p>;
  }

  const items = checkEventSetup({
    gamePluginSelected: Boolean(event.game_plugin_name),
    teamCount: teams.length,
    sessionCount: sessions.length,
  });

  if (items.some((item) => !item.ok)) {
    return (
      <div>
        <h1>{t("home.heading")}</h1>
        <ol className="list-plain">
          {items.map((item) => (
            <li className="list-row" key={item.key}>
              <span
                aria-label={item.ok ? t("home.doneLabel") : t("home.todoLabel")}
                role="img"
              >
                {item.ok ? "✓" : "✗"}
              </span>{" "}
              <Link to={ITEM_TARGETS[item.key]}>{t(`home.items.${item.key}`)}</Link>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const landing = pickLandingSession({
    sessions,
    windowsById,
    activeId: event.active_session_id,
    now: new Date(),
    fallbackZone: browserZone(),
  });
  return <Navigate replace to={`/sessions/${landing}/today`} />;
}
