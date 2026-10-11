/**
 * Earnings flags ("E") for the price chart: one per PAST report, dated 00:00
 * America/New_York of the report date (the chart snaps it to a bar, see
 * src/chart/markers.ts). Upcoming reports get no flag: they have no bar yet.
 *
 * The data comes from `useEarnings`, the same shared request the Earnings tab uses, so
 * having both on screen costs one HTTP request. Nothing is fetched while the server says
 * it has no fundamentals (capabilities.fundamentals is not true).
 */
import { useMemo } from 'react';
import type { ChartMarker } from '../chart/markers';
import { useCapabilities } from '../data';
import { useTheme } from '../theme';
import { outcomeOf, useEarnings } from './earnings';
import { newYorkMidnight } from './nyTime';
import { useI18n } from '../i18n';

const NONE: readonly ChartMarker[] = [];

/** Canvas drawing cannot resolve `var(--up)`, so read the theme's value, with the stock fallback. */
function themeColor(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v === '' ? fallback : v;
  } catch {
    return fallback;
  }
}

export function useEarningsMarkers(symbol: string): readonly ChartMarker[] {
  const caps = useCapabilities();
  const earnings = useEarnings(caps?.fundamentals === true ? symbol : null);
  const data = earnings.status === 'success' ? earnings.data : null;
  // useTheme() makes a theme change render this hook again. The colours are read on each
  // render: the theme is on <html> before that render (src/theme), and a changed colour
  // rebuilds the flags.
  // The language too: Chinese swaps the up and down colours, and the flag text is "财".
  useTheme();
  const { t } = useI18n();
  const up = themeColor('--up', '#26a69a');
  const down = themeColor('--down', '#ef5350');
  const text = t('fund.marker');

  return useMemo(() => {
    if (!data) return NONE;
    const out: ChartMarker[] = [];
    for (const e of data.events) {
      const outcome = outcomeOf(e);
      if (outcome === 'upcoming') continue;
      const time = newYorkMidnight(e.date);
      if (time === null) continue;
      const marker: ChartMarker = { id: `earnings-${data.symbol}-${e.date}`, time, text };
      if (outcome === 'beat') marker.color = up;
      else if (outcome === 'miss') marker.color = down;
      out.push(marker);
    }
    // Ascending by time, whatever order the server used.
    return out.sort((a, b) => a.time - b.time);
  }, [data, up, down, text]);
}
