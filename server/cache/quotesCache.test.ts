import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@shared/types';
import { QUOTE_TTL_MS, QuotesCache } from './quotesCache';

const snap = (symbol: string): Snapshot => ({ symbol, price: 1, change: 0, changePercent: 0, previousClose: 1, dayOpen: 1, dayHigh: 1, dayLow: 1, dayVolume: 1, updated: 1, delayed: false });

describe('QuotesCache', () => {
  it('expires entries after 15 seconds', () => {
    let now = 1_000; // not 0: lru-cache treats a start time of 0 as "no TTL"
    const c = new QuotesCache({ now: () => now });
    c.set('AAPL', snap('AAPL'));
    now = 1_000 + QUOTE_TTL_MS - 1;
    expect(c.get('AAPL')).toBeDefined();
    now = 1_000 + QUOTE_TTL_MS + 1;
    expect(c.get('AAPL')).toBeUndefined();
  });

  it('matches symbols case-insensitively', () => {
    const c = new QuotesCache();
    c.set('aapl', snap('AAPL'));
    expect(c.get('AapL')?.symbol).toBe('AAPL');
  });

  it('is bounded', () => {
    const c = new QuotesCache({ maxEntries: 2 });
    for (const s of ['A', 'B', 'C']) c.set(s, snap(s));
    expect(c.get('A')).toBeUndefined();
    expect(c.get('C')).toBeDefined();
  });
});
