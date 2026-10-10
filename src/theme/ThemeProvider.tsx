import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_THEME, applyTheme, readStoredTheme, storeTheme } from './theme';
import type { ThemeName, ThemeStorage } from './theme';

export interface ThemeState {
  theme: ThemeName;
  setTheme(name: ThemeName): void;
  toggleTheme(): void;
}

// Without a provider (components rendered alone in tests) the theme is the default and fixed.
const ThemeContext = createContext<ThemeState>({
  theme: DEFAULT_THEME,
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

export function ThemeProvider({ children, storage }: { children: ReactNode; storage?: () => ThemeStorage }) {
  const [theme, setState] = useState<ThemeName>(() => {
    const initial = readStoredTheme(storage);
    applyTheme(initial);
    return initial;
  });

  const setTheme = useCallback(
    (name: ThemeName) => {
      applyTheme(name); // first: the canvas reads the CSS colours during the next commit
      storeTheme(name, storage);
      setState(name);
    },
    [storage],
  );

  const value = useMemo<ThemeState>(
    () => ({ theme, setTheme, toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark') }),
    [theme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
