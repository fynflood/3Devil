import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "./types";

/** Remembered here too so the right colours show before the saved state loads. */
const KEY = "3devil-theme";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable; the saved settings still apply on load.
  }
  // Match the native title bar where the platform supports it.
  getCurrentWindow()
    .setTheme(theme === "system" ? null : theme)
    .catch(() => undefined);
}

/** Applies the last-used theme immediately at startup. */
export function applyStoredTheme() {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch {
    // Fall back to the system theme until settings load.
  }
}
