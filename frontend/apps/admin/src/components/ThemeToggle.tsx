import { useTranslation } from "react-i18next";
import { useTheme } from "../useTheme";

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.75" />
      <g stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
        <path d="M12 2.5v3" />
        <path d="M12 18.5v3" />
        <path d="M4.2 4.2l2.1 2.1" />
        <path d="M17.7 17.7l2.1 2.1" />
        <path d="M2.5 12h3" />
        <path d="M18.5 12h3" />
        <path d="M4.2 19.8l2.1-2.1" />
        <path d="M17.7 6.3l2.1-2.1" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.7 6.7 0 0 0 10.5 10.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? t("shell.switchToLight") : t("shell.switchToDark")}
      title={theme === "dark" ? t("shell.switchToLight") : t("shell.switchToDark")}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
