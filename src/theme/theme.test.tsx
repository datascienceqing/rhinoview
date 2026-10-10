import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { ThemeToggle } from '../ui/ThemeToggle';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { THEME_KEY, readStoredTheme } from './theme';
import type { ThemeStorage } from './theme';

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}
const throwing = (): ThemeStorage => {
  throw new DOMException('blocked', 'SecurityError');
};

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('readStoredTheme', () => {
  it('reads light or dark, and takes dark for anything else', () => {
    expect(readStoredTheme(() => memoryStorage({ [THEME_KEY]: 'light' }))).toBe('light');
    expect(readStoredTheme(() => memoryStorage({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(readStoredTheme(() => memoryStorage({ [THEME_KEY]: 'neon' }))).toBe('dark');
    expect(readStoredTheme(() => memoryStorage())).toBe('dark');
    expect(readStoredTheme(throwing)).toBe('dark');
  });
});

describe('ThemeProvider', () => {
  it('puts the stored theme on <html> before the first paint of its children', () => {
    let seenByChild: string | undefined;
    function Child() {
      seenByChild = document.documentElement.dataset.theme;
      return null;
    }
    const s = memoryStorage({ [THEME_KEY]: 'light' });
    render(
      <ThemeProvider storage={() => s}>
        <Child />
      </ThemeProvider>,
    );
    expect(seenByChild).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('changes <html> before child effects run, so the chart reads the new colours', () => {
    const seenInEffect: (string | undefined)[] = [];
    function Child() {
      const { theme, toggleTheme } = useTheme();
      useEffect(() => {
        seenInEffect.push(document.documentElement.dataset.theme);
      }, [theme]);
      return (
        <button type="button" onClick={toggleTheme}>
          toggle
        </button>
      );
    }
    const s = memoryStorage();
    render(
      <ThemeProvider storage={() => s}>
        <Child />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText('toggle'));
    expect(seenInEffect).toEqual(['dark', 'light']);
    expect(s.data[THEME_KEY]).toBe('light');
  });

  it('still changes the theme when storage is blocked', () => {
    render(
      <ThemeProvider storage={throwing}>
        <ThemeToggle />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it('names the theme it switches to, and switches both ways', () => {
    const s = memoryStorage();
    render(
      <ThemeProvider storage={() => s}>
        <ThemeToggle />
      </ThemeProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Switch to light theme' }).click());
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => screen.getByRole('button', { name: 'Switch to dark theme' }).click());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(s.data[THEME_KEY]).toBe('dark');
  });

  it('does nothing outside a provider, and shows the default (dark)', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
