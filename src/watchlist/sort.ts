import type { Snapshot } from '@shared/types';
import { normKey } from './format';

export type SortKey = 'symbol' | 'price' | 'change' | 'changePercent' | 'dayVolume' | 'range';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/**
 * Click cycle for a header: ascending, then descending, then off. Clicking a different
 * header starts that column at ascending.
 */
export function nextSort(current: SortState | null, key: SortKey): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** Day range width relative to the low. Sorting by "range" means sorting by this. */
export function rangeWidth(q: Snapshot): number | null {
  if (q.dayHigh === null || q.dayLow === null || q.dayLow <= 0) return null;
  return (q.dayHigh - q.dayLow) / q.dayLow;
}

function numeric(q: Snapshot | undefined, key: Exclude<SortKey, 'symbol'>): number | null {
  if (!q) return null;
  return key === 'range' ? rangeWidth(q) : q[key];
}

/**
 * Returns a sorted copy. Symbols with no number (missing, failed, still loading, or a
 * null field) go last in BOTH directions: they are not the "smallest" value.
 * Ties keep the saved order, because Array.prototype.sort is stable.
 */
export function sortSymbols(symbols: string[], quotes: ReadonlyMap<string, Snapshot>, sort: SortState | null): string[] {
  if (!sort) return symbols;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const { key } = sort;
  return [...symbols].sort((a, b) => {
    if (key === 'symbol') return sign * a.localeCompare(b);
    const x = numeric(quotes.get(normKey(a)), key);
    const y = numeric(quotes.get(normKey(b)), key);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y);
  });
}

/** Move the item at `from` so it ends at index `to`. Returns the same array when nothing moves. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}
