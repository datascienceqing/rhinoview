export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  accent: string;
}

// Fallbacks mirror :root in styles.css. They apply only where CSS variables cannot
// be resolved (jsdom, or a container detached from the stylesheet).
const FALLBACK: ChartTheme = {
  background: '#131722',
  text: '#d1d4dc',
  grid: '#2a2e39',
  border: '#2a2e39',
  up: '#26a69a',
  down: '#ef5350',
  accent: '#2962ff',
};

const VARS: Record<keyof ChartTheme, string> = {
  background: '--bg',
  text: '--text',
  grid: '--border',
  border: '--border',
  up: '--up',
  down: '--down',
  accent: '--accent',
};

/** Canvas can't read CSS variables, so resolve them to concrete colours once at chart creation. */
export function readTheme(el: Element): ChartTheme {
  if (typeof getComputedStyle === 'undefined') return FALLBACK;
  const style = getComputedStyle(el);
  const theme = { ...FALLBACK };
  for (const key of Object.keys(VARS) as (keyof ChartTheme)[]) {
    const value = style.getPropertyValue(VARS[key]).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

/** `#rrggbb` + alpha -> rgba(). Non-hex input is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m?.[1]) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
