import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, useAuth } from "@tournament-admin/shared";
import { TransientErrorBanner } from "./TransientErrorBanner";
import { DebugEventPanel } from "./DebugEventPanel";
import { ThemeToggle } from "./ThemeToggle";
import { GamePluginBanner } from "../gamePlugin/GamePluginBanner";
import { useGamePluginLiveUpdates } from "../gamePlugin/liveUpdates";
import { useRestartPoll } from "../useRestartPoll";
import { noteExplicitLogout } from "../routeGuards";
import { ActiveSessionBanner } from "../orientation/ActiveSessionBanner";
import { useActiveSessionLiveUpdates } from "../orientation/useActiveSessionLiveUpdates";
import { useEvent, useSessions } from "../orientation/useOrientationData";
import { useNow } from "../orientation/useNow";
import { SessionNavList } from "./SessionNavList";

function navLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

/** Mounted for admins only, so other roles never open the admin's channel. */
function AdminLiveUpdates() {
  useActiveSessionLiveUpdates();
  return null;
}

function AdminEventName() {
  const event = useEvent();
  return <h1 className="app-header__title">{event.data?.name ?? ""}</h1>;
}

function AdminHeaderStatus() {
  const { t } = useTranslation();
  const now = useNow(30_000);
  const event = useEvent();
  const sessions = useSessions();
  const activeId = event.data?.active_session_id ?? null;
  // An id missing from the list (deleted elsewhere) reads as no active session.
  const active = sessions.data?.find((s) => s.id === activeId);
  return (
    <>
      {active ? (
        <Link to={`/sessions/${active.id}/today`} className="badge badge-success app-header__session">
          <span className="live-dot" aria-hidden="true" />
          {t("shell.activeSessionPill", { label: active.label })}
        </Link>
      ) : (
        <span className="badge badge-neutral app-header__session">{t("shell.noActiveSession")}</span>
      )}
      <time className="app-header__clock" dateTime={now.toISOString()}>
        {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </time>
    </>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const { role, logout } = useAuth();
  const { status: switchStatus, start: startSwitchPoll } = useRestartPoll(undefined, "picker");
  const navRef = useRef<HTMLElement | null>(null);
  const location = useLocation();
  useGamePluginLiveUpdates();

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
      {role === "admin" && <AdminLiveUpdates />}
      <header className="app-header">
        {role === "admin" ? <AdminEventName /> : <h1 className="app-header__title">{t("app.title")}</h1>}
        <div className="app-header__actions">
          {role === "admin" && <AdminHeaderStatus />}
          <ThemeToggle />
          <button className="btn btn-small" onClick={() => {
              noteExplicitLogout();
              void logout();
            }}>
            {t("shell.logout")}
          </button>
        </div>
      </header>
      <TransientErrorBanner />
      <GamePluginBanner />
      {role === "admin" && <ActiveSessionBanner />}
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
            <h2 className="app-nav__group">{t("shell.groups.event")}</h2>
            <NavLink to="/events/setup" className={navLinkClassName}>
              {t("shell.eventGameLink")}
            </NavLink>
            <NavLink to="/teams" className={navLinkClassName}>
              {t("shell.teamsDivisionsLink")}
            </NavLink>
            <NavLink to="/devices" className={navLinkClassName}>
              {t("shell.devicesDisplaysLink")}
            </NavLink>
            <NavLink to="/rankings" className={navLinkClassName}>
              {t("shell.seasonRankingsLink")}
            </NavLink>
            <h2 className="app-nav__group">{t("shell.groups.sessions")}</h2>
            <SessionNavList />
            <h2 className="app-nav__group">{t("shell.groups.settings")}</h2>
            <NavLink to="/settings/roles" className={navLinkClassName}>
              {t("shell.rolesLink")}
            </NavLink>
            <NavLink to="/backups" className={navLinkClassName}>
              {t("shell.backupsLink")}
            </NavLink>
            <button
              type="button"
              className="app-nav__action"
              onClick={() => switchMutation.mutate()}
              disabled={switchMutation.isPending}
            >
              {t("picker.switchAction")}
            </button>
          </nav>
        )}
        {role === "front_desk" && (
          <nav className="app-nav" ref={navRef}>
            <NavLink to="/checkin" className={navLinkClassName}>
              {t("shell.checkinLink")}
            </NavLink>
          </nav>
        )}
        {role === "judge" && (
          <nav className="app-nav" ref={navRef}>
            <NavLink to="/judge/awards" className={navLinkClassName}>
              {t("shell.judgeAwardsLink")}
            </NavLink>
            <NavLink to="/judge/rankings" className={navLinkClassName}>
              {t("shell.judgeSessionRankingsLink")}
            </NavLink>
            <NavLink to="/rankings" className={navLinkClassName}>
              {t("shell.seasonRankingsLink")}
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
