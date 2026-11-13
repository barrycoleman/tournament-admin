import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";

function tabLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function TeamsLayout() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t("teamsLayout.heading")}</h1>
      <nav className="app-nav app-nav--sub">
        <NavLink to="/teams" end className={tabLinkClassName}>
          {t("teamsLayout.teamsTab")}
        </NavLink>
        <NavLink to="/teams/divisions" className={tabLinkClassName}>
          {t("teamsLayout.divisionsTab")}
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
