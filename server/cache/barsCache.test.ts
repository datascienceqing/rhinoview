import { describe, expect, it } from 'vitest';
import type { Bar, BarsResponse } from '@shared/types';
import { BarsCache } from './barsCache';
import type { BarsCacheKey } from './barsCache';

const bar = (t: number): Bar => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1, vwap: null, transactions: null });
const resp = (n: number): BarsResponse => ({
  symbol: 'AAPL',
  timeframe: '1D',
  adjusted: true,
  bars: Array.from({ length: n }, (_, i) => bar(i)),
  truncated: false,
  cached: false,
});
const key = (from: number): BarsCacheKey => ({ symbol: 'AAPL', timeframe: '1D', from, to: 1000, adjusted: true });

describe('BarsCache size bound', () => {
  it('is bounded by summed bar count, not by entry count', () => {
    const cache = new BarsCache({ maxBars: 100 });
    for (let i = 0; i < 20; i++) cache.set(key(i), resp(10)); // 200 bars offered
    expect(cache.totalBars).toBeLessThanOrEqual(100);
    expect(cache.size).toBe(10);
  });

  it('many small entries fit where a few big ones would not', () => {
    const cache = new BarsCache({ maxBars: 100 });
    for (let i = 0; i < 50; i++) cache.set(key(i), resp(2));
    expect(cache.size).toBe(50);
    cache.set(key(999), resp(90)); // evicts least recently used until it fits
    expect(cache.totalBars).toBeLessThanOrEqual(100);
    expect(cache.get(key(999))).toBeDefined();
    expect(cache.get(key(0))).toBeUndefined();
  });

  it('does not store a single response larger than the whole budget', () => {
    const cache = new BarsCache({ maxBars: 100 });
    cache.set(key(1), resp(101));
    expect(cache.get(key(1))).toBeUndefined();
    expect(cache.totalBars).toBe(0);
  });

  it('counts an empty response as one so empties cannot grow without bound', () => {
    const cache = new BarsCache({ maxBars: 5 });
    for (let i = 0; i < 50; i++) cache.set(key(i), resp(0));
    expect(cache.size).toBeLessThanOrEqual(5);
  });

  it('defaults to a budget of a few hundred thousand bars, not tens of millions', () => {
    const cache = new BarsCache();
    // 10 entries at the largest per-request cap (10,000 bars) must not blow past the budget.
    for (let i = 0; i < 40; i++) cache.set(key(i), resp(10_000));
    expect(cache.totalBars).toBeLessThanOrEqual(250_000);
  });
});
