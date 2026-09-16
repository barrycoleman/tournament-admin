import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, useAuth } from "@tournament-admin/shared";
import { TransientErrorBanner } from "./TransientErrorBanner";
import { DebugEventPanel } from "./DebugEventPanel";
import { useRestartPoll } from "../useRestartPoll";

export function AppShell() {
  const { t } = useTranslation();
  const { role, logout } = useAuth();
  const { status: switchStatus, start: startSwitchPoll } = useRestartPoll();

  const switchMutation = useMutation({
    mutationFn: () => apiRequest<unknown>("/api/picker/switch", { method: "POST" }),
    onSuccess: () => startSwitchPoll(),
  });

  if (switchStatus === "waiting") {
    return (
      <div>
        <p role="status">{t("picker.restartingMessage")}</p>
      </div>
    );
  }

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
      {role === "admin" && (
        <button onClick={() => switchMutation.mutate()} disabled={switchMutation.isPending}>
          {t("picker.switchAction")}
        </button>
      )}
      {switchMutation.isError && <p role="alert">{t("errors.generic")}</p>}
      {role === "admin" && <DebugEventPanel />}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
