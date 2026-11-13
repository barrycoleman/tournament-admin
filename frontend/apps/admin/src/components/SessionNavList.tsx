import { Fragment } from "react";
import { Link, NavLink, matchPath, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { orderSessions } from "../orientation/sessionTime";
import { useEvent, useSessions } from "../orientation/useOrientationData";
import { useSkillsSettings } from "../skills/useSkillsSettings";

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? "app-nav__sub-link active" : "app-nav__sub-link";
}

/** The admin menu's Sessions group: one entry per session, the active one with its controls. */
export function SessionNavList() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const event = useEvent();
  const sessions = useSessions();
  const skills = useSkillsSettings();
  const ordered = orderSessions(sessions.data ?? []);
  const activeId = event.data?.active_session_id ?? null;

  return (
    <>
      {ordered.map((session) => {
        const isActive = session.id === activeId;
        // The session's entry stays current on every one of its pages, not only Today.
        const current = matchPath(`/sessions/${session.id}/*`, pathname) !== null;
        return (
          <Fragment key={session.id}>
            <Link
              to={`/sessions/${session.id}/today`}
              className={current ? "active" : undefined}
              aria-current={current ? "page" : undefined}
              aria-label={isActive ? t("shell.activeSessionLink", { label: session.label }) : undefined}
            >
              {isActive && <span className="live-dot" aria-hidden="true" />}
              {session.label}
            </Link>
            {isActive && (
              <>
                <NavLink to="/match-control" className={navLinkClassName}>
                  {t("shell.matchControlLink")}
                </NavLink>
                {skills.data?.enabled && (
                  <NavLink to="/skills-control" className={navLinkClassName}>
                    {t("shell.skillsControlLink")}
                  </NavLink>
                )}
              </>
            )}
          </Fragment>
        );
      })}
      <NavLink to="/sessions/new" end className={({ isActive }) => (isActive ? "active" : undefined)}>
        {t("shell.newSessionLink")}
      </NavLink>
      <NavLink to="/sessions" end className={({ isActive }) => (isActive ? "active" : undefined)}>
        {t("shell.manageSessionsLink")}
      </NavLink>
    </>
  );
}
