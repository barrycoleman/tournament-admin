import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "tournament-admin.theme.v1";

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

/**
 * Persists an explicit light/dark choice as `data-theme` on <html>, which
 * tokens.css reads to override the `prefers-color-scheme` default. No
 * stored choice means "follow the system setting" -- toggling only ever
 * writes an explicit value, it never clears back to "system" once set,
 * matching how most apps' theme switches behave.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? (systemPrefersDark() ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Best-effort persistence; a private-browsing session still works
        // for the current tab even if the choice doesn't survive reload.
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
