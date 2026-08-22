import React from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

const isDarkNow = () => document.documentElement.classList.contains("dark");
const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Tracks the `dark` class on <html> so non-CSS renderers (mermaid) can follow theme changes. */
export function useIsDark() {
  const [isDark, setIsDark] = React.useState(isDarkNow);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(isDarkNow()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyTheme(preference: ThemePreference) {
  const dark = preference === "system" ? prefersDark() : preference === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(preference: ThemePreference) {
  if (preference === "system") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, preference);
  }
  applyTheme(preference);
}

/** Reads the stored choice and, on "system", keeps following the OS while open. */
export function useThemePreference() {
  const [preference, setPreference] = React.useState<ThemePreference>(getThemePreference);

  React.useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme("system");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [preference]);

  const choose = React.useCallback((next: ThemePreference) => {
    setTheme(next);
    setPreference(next);
  }, []);

  return { preference, setPreference: choose };
}
