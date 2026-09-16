import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, useAuth } from "@tournament-admin/shared";
import { TransientErrorBanner } from "./TransientErrorBanner";
import { DebugEventPanel } from "./DebugEventPanel";
import { ThemeToggle } from "./ThemeToggle";
import { useRestartPoll } from "../useRestartPoll";

function navLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function AppShell() {
  const { t } = useTranslation();
  const { role, logout } = useAuth();
  const { status: switchStatus, start: startSwitchPoll } = useRestartPoll(undefined, "picker");
  const navRef = useRef<HTMLElement | null>(null);
  const location = useLocation();

  // On the collapsed mobile nav (a horizontal scrollable strip, see
  // components.css's 720px breakpoint), the active destination can start
  // scrolled out of view -- keep it visible on every navigation rather
  // than leaving it to chance.
  useEffect(() => {
    navRef.current?.querySelector(".active")?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }, [location.pathname]);

  const switchMutation = useMutation({
    mutationFn: () => apiRequest<unknown>("/api/picker/switch", { method: "POST" }),
    onSuccess: () => startSwitchPoll(),
  });

  if (switchStatus === "waiting") {
    return (
      <div className="picker-restarting">
        <p role="status">{t("picker.restartingMessage")}</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">{t("app.title")}</h1>
        <div className="app-header__actions">
          {role === "admin" && (
            <button
              className="btn btn-small"
              onClick={() => switchMutation.mutate()}
              disabled={switchMutation.isPending}
            >
              {t("picker.switchAction")}
            </button>
          )}
          <ThemeToggle />
          <button className="btn btn-small" onClick={() => void logout()}>
            {t("shell.logout")}
          </button>
        </div>
      </header>
      <TransientErrorBanner />
      {switchMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {t("errors.generic")}
        </p>
      )}
      {switchStatus === "timedOut" && (
        <p className="alert alert-danger" role="alert">
          {t("picker.restartTimedOutMessage")}
        </p>
      )}
      <div className="app-body">
        {role === "admin" && (
          <nav className="app-nav" ref={navRef}>
            <NavLink to="/" className={navLinkClassName}>
              {t("shell.dashboardLink")}
            </NavLink>
            <NavLink to="/events/setup" className={navLinkClassName}>
              {t("shell.eventSetupLink")}
            </NavLink>
            <NavLink to="/settings/roles" className={navLinkClassName}>
              {t("shell.rolesLink")}
            </NavLink>
            <NavLink to="/divisions" className={navLinkClassName}>
              {t("shell.divisionsLink")}
            </NavLink>
            <NavLink to="/teams" className={navLinkClassName}>
              {t("shell.teamsLink")}
            </NavLink>
          </nav>
        )}
        <main className="app-main">
          <Outlet />
          {role === "admin" && <DebugEventPanel />}
        </main>
      </div>
    </div>
  );
}
