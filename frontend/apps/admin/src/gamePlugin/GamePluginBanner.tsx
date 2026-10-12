import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@tournament-admin/shared";
import { GAME_PLUGIN_SECTION_PATH, useGamePlugin } from "./useGamePlugin";

/** Admin-only, on every page but Event Setup, until a game plugin is chosen. */
export function GamePluginBanner() {
  const { t } = useTranslation();
  const { role } = useAuth();
  const { pathname } = useLocation();
  const { selected, isLoading } = useGamePlugin();
  if (role !== "admin" || isLoading || selected || pathname === "/events/setup") return null;
  return (
    <p className="alert alert-warning game-plugin-banner" role="status">
      {t("gamePlugin.banner")} <Link to={GAME_PLUGIN_SECTION_PATH}>{t("gamePlugin.bannerLink")}</Link>
    </p>
  );
}
