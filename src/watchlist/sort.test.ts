import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@shared/types';
import { moveItem, nextSort, sortSymbols } from './sort';

const snap = (symbol: string, price: number | null, extra: Partial<Snapshot> = {}): Snapshot => ({
  symbol, price, change: null, changePercent: null, previousClose: null, dayOpen: null,
  dayHigh: null, dayLow: null, dayVolume: null, updated: null, delayed: false, ...extra,
});

describe('nextSort', () => {
  it('cycles ascending, descending, off, and restarts on another column', () => {
    const a = nextSort(null, 'price');
    expect(a).toEqual({ key: 'price', dir: 'asc' });
    const d = nextSort(a, 'price');
    expect(d).toEqual({ key: 'price', dir: 'desc' });
    expect(nextSort(d, 'price')).toBeNull();
    expect(nextSort(d, 'change')).toEqual({ key: 'change', dir: 'asc' });
  });
});

describe('sortSymbols', () => {
  const quotes = new Map([['A', snap('A', 30)], ['B', snap('B', 10)], ['C', snap('C', 20)]]);
  it('reorders by value in both directions and leaves the input untouched', () => {
    const input = ['A', 'B', 'C'];
    expect(sortSymbols(input, quotes, { key: 'price', dir: 'asc' })).toEqual(['B', 'C', 'A']);
    expect(sortSymbols(input, quotes, { key: 'price', dir: 'desc' })).toEqual(['A', 'C', 'B']);
    expect(input).toEqual(['A', 'B', 'C']);
  });
  it('puts symbols without a value last in both directions', () => {
    const input = ['X', 'A', 'B'];
    expect(sortSymbols(input, quotes, { key: 'price', dir: 'asc' })).toEqual(['B', 'A', 'X']);
    expect(sortSymbols(input, quotes, { key: 'price', dir: 'desc' })).toEqual(['A', 'B', 'X']);
  });
  it('sorts by symbol name', () => {
    expect(sortSymbols(['B', 'C', 'A'], quotes, { key: 'symbol', dir: 'asc' })).toEqual(['A', 'B', 'C']);
  });
  it('returns the saved order when sort is off', () => {
    const input = ['C', 'A'];
    expect(sortSymbols(input, quotes, null)).toBe(input);
  });
});

describe('moveItem', () => {
  it('moves an item and ignores out-of-range moves', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    const same = ['a', 'b'];
    expect(moveItem(same, 0, -1)).toBe(same);
    expect(moveItem(same, 1, 2)).toBe(same);
  });
});
