import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@tournament-admin/shared";
import { GAME_PLUGIN_SECTION_PATH, useGamePlugin } from "./useGamePlugin";

/** Stands in for a screen that can't work without a game plugin. */
export function NeedsGamePlugin() {
  const { t } = useTranslation();
  const { role } = useAuth();
  if (role !== "admin") {
    return (
      <p className="alert alert-warning" role="status">
        {t("gamePlugin.needsOther")}
      </p>
    );
  }
  return (
    <p className="alert alert-warning" role="status">
      {t("gamePlugin.needsAdmin")} <Link to={GAME_PLUGIN_SECTION_PATH}>{t("gamePlugin.needsAdminLink")}</Link>
    </p>
  );
}

/** Renders `children` only once the event has a game plugin; nothing while that's loading. */
export function RequiresGamePlugin({ children }: { children: ReactNode }) {
  const { selected, isLoading } = useGamePlugin();
  if (isLoading) return null;
  return selected ? <>{children}</> : <NeedsGamePlugin />;
}
