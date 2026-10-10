/**
 * The app colour theme: dark (the default) or light.
 *
 * The theme is a per-browser preference, like the sidebar width, so it lives in
 * localStorage and not in the server workspace. It is applied as `data-theme` on
 * <html>; styles.css defines the colour tokens for each value.
 */
export type ThemeName = 'dark' | 'light';

export const THEME_KEY = 'rhinoview:theme';
export const DEFAULT_THEME: ThemeName = 'dark';

/** The slice of `Storage` we use, so tests can hand in a throwing or in-memory stand-in. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `window.localStorage` itself can throw on access, so it is resolved inside each try/catch. */
const defaultStorage = (): ThemeStorage => globalThis.localStorage;

export function readStoredTheme(storage: () => ThemeStorage = defaultStorage): ThemeName {
  try {
    const v = storage().getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(name: ThemeName, storage: () => ThemeStorage = defaultStorage): void {
  try {
    storage().setItem(THEME_KEY, name);
  } catch {
    // Private mode or blocked site data: the theme still applies until the page reloads.
  }
}

/**
 * Set the theme on <html> at once. Call it BEFORE the React state changes: child effects
 * run before parent effects, and the chart reads the CSS colours in its effect.
 */
export function applyTheme(name: ThemeName, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = name;
}
