/**
 * The math of the drawing tools, with no chart in it.
 *
 * A drawing point is saved as a bar time and a price (an `Anchor`), not as a bar index:
 * older history prepends bars and moves every index, but a time stays on its bar. A point
 * right of the last bar (the empty space of the time scale) has no bar, so its time is
 * extrapolated with the spacing of the last two bars.
 */
import type { Bar } from '@shared/types';

export type DrawingTool = 'measure' | 'fib';

/** A saved drawing point: Unix seconds and a price. */
export interface Anchor {
  time: number;
  price: number;
}

/** A drawing point on screen: a bar index (logical index) and a price. */
export interface IndexPoint {
  index: number;
  price: number;
}

export interface Segment<P> {
  a: P;
  b: P;
}

/**
 * The Fibonacci levels of TradingView's default Fib retracement. Level 1 is at the first
 * point and level 0 at the second; the levels above 1 extend past the first point.
 */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236] as const;

/** The price of `level` on a retracement from `a` to `b`. */
export function fibPrice(a: number, b: number, level: number): number {
  return b + (a - b) * level;
}

export interface MeasureStats {
  /** The price change from `a` to `b`. */
  change: number;
  /** The change in percent of the price at `a`; null when that price is 0. */
  percent: number | null;
  /** Bars from `a` to `b`; negative when `b` is left of `a`. */
  bars: number;
}

export function measureStats(seg: Segment<IndexPoint>): MeasureStats {
  const change = seg.b.price - seg.a.price;
  return {
    change,
    percent: seg.a.price === 0 ? null : (change / seg.a.price) * 100,
    bars: Math.round(seg.b.index - seg.a.index),
  };
}

/** Seconds between bars near the start (`atEnd` false) or the end of `bars`; 0 with fewer than two bars. */
function step(bars: readonly Bar[], atEnd: boolean): number {
  const n = bars.length;
  if (n < 2) return 0;
  return atEnd ? (bars[n - 1] as Bar).time - (bars[n - 2] as Bar).time : (bars[1] as Bar).time - (bars[0] as Bar).time;
}

/** The time of bar `index`. An index outside the bars is extrapolated. Needs at least one bar. */
export function indexToTime(bars: readonly Bar[], index: number): number {
  const i = Math.round(index);
  const last = bars.length - 1;
  if (i < 0) return (bars[0] as Bar).time + i * step(bars, false);
  if (i > last) return (bars[last] as Bar).time + (i - last) * step(bars, true);
  return (bars[i] as Bar).time;
}

/**
 * The bar index of `time`: the first bar at or after it. A time outside the bars is
 * extrapolated, so a point in the empty space stays there. Needs at least one bar.
 */
export function timeToIndex(bars: readonly Bar[], time: number): number {
  const last = bars.length - 1;
  const first = bars[0] as Bar;
  const end = bars[last] as Bar;
  if (time > end.time) {
    const s = step(bars, true);
    return s > 0 ? last + Math.round((time - end.time) / s) : last;
  }
  if (time < first.time) {
    const s = step(bars, false);
    return s > 0 ? -Math.round((first.time - time) / s) : 0;
  }
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as Bar).time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function toIndexPoint(bars: readonly Bar[], p: Anchor): IndexPoint {
  return { index: timeToIndex(bars, p.time), price: p.price };
}

export function toAnchor(bars: readonly Bar[], p: IndexPoint): Anchor {
  return { time: indexToTime(bars, p.index), price: p.price };
}
