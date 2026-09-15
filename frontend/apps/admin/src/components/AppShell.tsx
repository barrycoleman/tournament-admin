import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@tournament-admin/shared";
import { TransientErrorBanner } from "./TransientErrorBanner";
import { DebugEventPanel } from "./DebugEventPanel";

export function AppShell() {
  const { t } = useTranslation();
  const { role, logout } = useAuth();

  return (
    <div>
      <header>
        <p>{t("app.title")}</p>
        <button onClick={() => void logout()}>{t("shell.logout")}</button>
      </header>
      <TransientErrorBanner />
      {role === "admin" && (
        <nav>
          <NavLink to="/">{t("shell.dashboardLink")}</NavLink>
          <NavLink to="/events/setup">{t("shell.eventSetupLink")}</NavLink>
          <NavLink to="/settings/roles">{t("shell.rolesLink")}</NavLink>
          <NavLink to="/divisions">{t("shell.divisionsLink")}</NavLink>
          <NavLink to="/teams">{t("shell.teamsLink")}</NavLink>
        </nav>
      )}
      {role === "admin" && <DebugEventPanel />}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
