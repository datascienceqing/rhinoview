import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, applyLocale, readStoredLocale, storeLocale } from './locale';
import type { Locale, LocaleStorage } from './locale';
import { translateIn } from './translate';
import type { MessageArgs, MessageKey, Translate } from './translate';

export interface I18nState {
  locale: Locale;
  setLocale(locale: Locale): void;
  toggleLocale(): void;
  /** Translate in this state's language. A new function per language, so memoized children re-render. */
  t: Translate;
}

const bound = (locale: Locale): Translate =>
  (<K extends MessageKey>(key: K, ...args: MessageArgs<K>) => translateIn(locale, key, ...args)) as Translate;

// Without a provider (components rendered alone in tests) the language is English and fixed.
const I18nContext = createContext<I18nState>({
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  toggleLocale: () => undefined,
  t: bound(DEFAULT_LOCALE),
});

export interface I18nProviderProps {
  children: ReactNode;
  storage?: () => LocaleStorage;
  /** The browser languages, for tests. Defaults to `navigator.languages`. */
  languages?: readonly string[];
}

export function I18nProvider({ children, storage, languages }: I18nProviderProps) {
  const [locale, setState] = useState<Locale>(() => {
    const initial = readStoredLocale(storage, languages);
    applyLocale(initial);
    return initial;
  });

  const setLocale = useCallback(
    (next: Locale) => {
      applyLocale(next); // first: the chart reads the colours and labels during the next commit
      storeLocale(next, storage);
      setState(next);
    },
    [storage],
  );

  const value = useMemo<I18nState>(
    () => ({ locale, setLocale, toggleLocale: () => setLocale(locale === 'en' ? 'zh' : 'en'), t: bound(locale) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  return useContext(I18nContext);
}
