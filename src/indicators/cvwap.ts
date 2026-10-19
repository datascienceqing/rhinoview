/**
 * Chart VWAP: the VWAP of a window of bars, anchored on the window's first bar.
 *
 * Follows the user's Pine script "Chart VWAP" (v2 2023.01.19): `ta.vwap(hlc3, anchor, mult)`
 * with the anchor on the leftmost visible bar, the mean close of the visible bars
 * (`PCvc.avg`), and the open, high, low and close of the visible range (`PCvc.ohlcv`).
 *
 * Pure: no DOM, clock or randomness. The chart layer calls it on each redraw with the
 * visible window, and memoizes the result on that window (src/panes/cvwap/CvwapPrimitive.ts).
 */
import type { Bar } from '@shared/types';

export interface CvwapResult {
  /** The window, inclusive. Index k of the arrays below is bar `from + k`. */
  from: number;
  to: number;
  /** VWAP per bar; null until the window has volume. */
  vwap: (number | null)[];
  /** VWAP + and - `bandMult` standard deviations; null where the VWAP is null. */
  upper: (number | null)[];
  lower: (number | null)[];
  /** Mean close of the window. */
  average: number;
  /** Open of the first bar, highest high, lowest low, close of the last bar. */
  open: number;
  high: number;
  low: number;
  close: number;
}

const hasVolume = (b: Bar): boolean => Number.isFinite(b.volume) && b.volume > 0;

/**
 * The Chart VWAP of `bars[i0..i1]` (inclusive, clamped to the array), or null when the
 * window holds no bars. Like Pine's `ta.vwap`, the bands are the VWAP plus and minus
 * `bandMult` times the volume-weighted standard deviation of hlc3 around it. A bar with no
 * volume adds nothing to the VWAP.
 */
export function computeCvwap(bars: readonly Bar[], i0: number, i1: number, bandMult: number): CvwapResult | null {
  const from = Math.max(0, i0);
  const to = Math.min(bars.length - 1, i1);
  if (from > to) return null;

  const first = bars[from] as Bar;
  const vwap: (number | null)[] = [];
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  let sumV = 0;
  let sumPV = 0;
  let sumP2V = 0;
  let sumClose = 0;
  let high = -Infinity;
  let low = Infinity;

  for (let i = from; i <= to; i += 1) {
    const b = bars[i] as Bar;
    sumClose += b.close;
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    if (hasVolume(b)) {
      const p = (b.high + b.low + b.close) / 3;
      sumV += b.volume;
      sumPV += p * b.volume;
      sumP2V += p * p * b.volume;
    }
    if (sumV === 0) {
      vwap.push(null);
      upper.push(null);
      lower.push(null);
      continue;
    }
    const v = sumPV / sumV;
    // Rounding can make the variance a tiny negative number on a flat window.
    const dev = Math.sqrt(Math.max(0, sumP2V / sumV - v * v)) * bandMult;
    vwap.push(v);
    upper.push(v + dev);
    lower.push(v - dev);
  }

  return {
    from,
    to,
    vwap,
    upper,
    lower,
    average: sumClose / (to - from + 1),
    open: first.open,
    high,
    low,
    close: (bars[to] as Bar).close,
  };
}
