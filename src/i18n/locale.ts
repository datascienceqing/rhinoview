/**
 * The interface language: English or Simplified Chinese.
 *
 * Like the theme, the language is a per-browser preference. The first visit follows the
 * browser (`zh*` gives Chinese); the toolbar toggle overrides it and the choice is kept in
 * localStorage. It is applied as `data-locale` and `lang` on <html>. styles.css swaps the
 * up and down colours for Chinese (red up, green down), so the colours follow the language.
 *
 * Code that is not React (canvas painters, formatters) reads the current language with
 * `getLocale()`. `applyLocale` sets it, BEFORE the React state changes, like `applyTheme`:
 * the chart reads the CSS colours and the labels during the next commit.
 */
export type Locale = 'en' | 'zh';

export const LOCALE_KEY = 'rhinoview:locale';
export const DEFAULT_LOCALE: Locale = 'en';
/** BCP 47 tags for Intl and the `lang` attribute. */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-US', zh: 'zh-CN' };

/** The slice of `Storage` we use, so tests can hand in a throwing or in-memory stand-in. */
export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage = (): LocaleStorage => globalThis.localStorage;
const browserLanguages = (): readonly string[] =>
  typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];

let current: Locale = DEFAULT_LOCALE;

/** The language in force now. English until `applyLocale` runs. */
export function getLocale(): Locale {
  return current;
}

/** The browser's first language, as one of ours: Chinese for any `zh*` tag, else English. */
export function detectLocale(languages: readonly string[] = browserLanguages()): Locale {
  const first = languages.find((l) => typeof l === 'string' && l.length > 0);
  return first?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** The stored choice, or the browser's language when there is none. */
export function readStoredLocale(storage: () => LocaleStorage = defaultStorage, languages?: readonly string[]): Locale {
  try {
    const v = storage().getItem(LOCALE_KEY);
    if (v === 'en' || v === 'zh') return v;
  } catch {
    // Blocked site data: fall back to the browser's language.
  }
  return detectLocale(languages);
}

export function storeLocale(locale: Locale, storage: () => LocaleStorage = defaultStorage): void {
  try {
    storage().setItem(LOCALE_KEY, locale);
  } catch {
    // Private mode or blocked site data: the language still applies until the page reloads.
  }
}

/** Set the language for non-React code and on <html>. */
export function applyLocale(locale: Locale, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  current = locale;
  if (!root) return;
  root.dataset.locale = locale;
  root.lang = INTL_LOCALE[locale];
}
