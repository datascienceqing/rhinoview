import type { Bar } from '@shared/types';
import type { CandlestickData, LineData, UTCTimestamp } from 'lightweight-charts';

// Bar.time is Unix seconds, which is exactly what UTCTimestamp means. The cast is
// type-level only (UTCTimestamp is a nominal brand over number): NO unit conversion.
function ts(bar: Bar): UTCTimestamp {
  return bar.time as UTCTimestamp;
}

export function toCandles(bars: readonly Bar[]): CandlestickData<UTCTimestamp>[] {
  return bars.map((b) => ({ time: ts(b), open: b.open, high: b.high, low: b.low, close: b.close }));
}

/** Line and area series plot the close. */
export function toCloseLine(bars: readonly Bar[]): LineData<UTCTimestamp>[] {
  return bars.map((b) => ({ time: ts(b), value: b.close }));
}

/** Binary search; `bars` is ascending by time (contract guarantee). */
export function findBarIndexByTime(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = bars[mid]?.time;
    if (t === undefined) return -1;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export type BarsUpdate = { kind: 'same' } | { kind: 'replace' } | { kind: 'prepend'; added: number };

/**
 * How `next` differs from `prev`. Distinguishing a prepend (older history arrived)
 * from a replace (new symbol/timeframe) is what lets the chart keep the user's
 * scroll position in the first case and reset the view in the second.
 */
export function classifyUpdate(prev: readonly Bar[], next: readonly Bar[]): BarsUpdate {
  if (prev === next) return { kind: 'same' };
  const prevFirst = prev[0];
  const prevLast = prev[prev.length - 1];
  const nextLast = next[next.length - 1];
  if (!prevFirst || !prevLast || !nextLast) return { kind: 'replace' };
  const added = next.length - prev.length;
  if (added > 0 && nextLast.time === prevLast.time && next[added]?.time === prevFirst.time) {
    return { kind: 'prepend', added };
  }
  return { kind: 'replace' };
}
