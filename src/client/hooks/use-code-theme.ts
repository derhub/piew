import React from "react";
import { useIsDark } from "~/hooks/use-theme";

/**
 * A choice is a light/dark pair, not one theme: the surfaces take a
 * `{ light, dark }` map and follow the app's appearance on their own.
 */
export const CODE_THEMES = {
  pierre: { label: "Pierre", light: "pierre-light", dark: "pierre-dark" },
  github: { label: "GitHub", light: "github-light", dark: "github-dark" },
  vitesse: { label: "Vitesse", light: "vitesse-light", dark: "vitesse-dark" },
  catppuccin: { label: "Catppuccin", light: "catppuccin-latte", dark: "catppuccin-mocha" },
  "rose-pine": { label: "Rose Pine", light: "rose-pine-dawn", dark: "rose-pine-moon" },
  gruvbox: { label: "Gruvbox", light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  one: { label: "One", light: "one-light", dark: "one-dark-pro" },
  min: { label: "Min", light: "min-light", dark: "min-dark" },
  nord: { label: "Nord", light: "github-light", dark: "nord" },
} as const;

export type CodeThemeName = keyof typeof CODE_THEMES;

const STORAGE_KEY = "piew:code-theme";
const DEFAULT: CodeThemeName = "github";

function stored(): CodeThemeName {
  const value = localStorage.getItem(STORAGE_KEY);
  return value && value in CODE_THEMES ? (value as CodeThemeName) : DEFAULT;
}

const listeners = new Set<(name: CodeThemeName) => void>();

export function setCodeTheme(name: CodeThemeName) {
  localStorage.setItem(STORAGE_KEY, name);
  for (const listener of listeners) listener(name);
}

/** Every surface reads the same choice, so a change repaints all of them at once. */
export function useCodeTheme() {
  const [name, setName] = React.useState<CodeThemeName>(stored);
  const isDark = useIsDark();

  React.useEffect(() => {
    listeners.add(setName);
    return () => void listeners.delete(setName);
  }, []);

  const entry = CODE_THEMES[name];
  const themes = React.useMemo(() => ({ light: entry.light, dark: entry.dark }), [entry]);

  return { name, setName: setCodeTheme, themes, active: isDark ? entry.dark : entry.light };
}
