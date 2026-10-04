/** Invariant 9: cache for hours (overview and statements 6 h, earnings 1 h), successes only. */
import { describe, expect, it, vi } from 'vitest';
import type { EarningsResponse, FundamentalsOverview, StatementsResponse } from '@shared/types';
import { RateLimitedError } from '../provider/errors';
import { UnknownSymbolError } from '../market/types';
import {
  CachedFundamentalsProvider,
  EARNINGS_TTL_MS,
  MAX_CACHE_ENTRIES,
  OVERVIEW_TTL_MS,
  STATEMENTS_TTL_MS,
} from './cache';
import type { FundamentalsProvider } from './types';

const HOUR = 3_600_000;

function setup() {
  let t = 1_000_000;
  const overview = vi.fn((symbol: string) => Promise.resolve({ profile: { symbol } } as unknown as FundamentalsOverview));
  const statements = vi.fn((symbol: string) => Promise.resolve({ symbol } as unknown as StatementsResponse));
  const earnings = vi.fn((symbol: string) => Promise.resolve({ symbol, events: [] } as EarningsResponse));
  const inner: FundamentalsProvider = { available: true, getOverview: overview, getStatements: statements, getEarnings: earnings };
  const cache = new CachedFundamentalsProvider(inner, () => t);
  return { cache, overview, statements, earnings, advance: (ms: number) => void (t += ms) };
}

describe('TTLs', () => {
  it('states 6 h for overview and statements and 1 h for earnings', () => {
    expect(OVERVIEW_TTL_MS).toBe(6 * HOUR);
    expect(STATEMENTS_TTL_MS).toBe(6 * HOUR);
    expect(EARNINGS_TTL_MS).toBe(1 * HOUR);
  });

  it('serves the overview from cache until exactly 6 h, then refetches', async () => {
    const { cache, overview, advance } = setup();
    await cache.getOverview('AAPL');
    advance(6 * HOUR - 1);
    await cache.getOverview('AAPL');
    expect(overview).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.getOverview('AAPL');
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it('serves statements from cache until exactly 6 h', async () => {
    const { cache, statements, advance } = setup();
    await cache.getStatements('AAPL', 'income', 'annual');
    advance(6 * HOUR - 1);
    await cache.getStatements('AAPL', 'income', 'annual');
    expect(statements).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.getStatements('AAPL', 'income', 'annual');
    expect(statements).toHaveBeenCalledTimes(2);
  });

  it('serves earnings from cache for 1 h only, not 6 h', async () => {
    const { cache, earnings, advance } = setup();
    await cache.getEarnings('AAPL');
    advance(HOUR - 1);
    await cache.getEarnings('AAPL');
    expect(earnings).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.getEarnings('AAPL');
    expect(earnings).toHaveBeenCalledTimes(2);
  });
});

describe('what is cached', () => {
  it('caches successes only: a failure is retried on the next call', async () => {
    const { cache, overview } = setup();
    overview.mockRejectedValueOnce(new RateLimitedError(5));
    await expect(cache.getOverview('AAPL')).rejects.toBeInstanceOf(RateLimitedError);
    await expect(cache.getOverview('AAPL')).resolves.toBeDefined();
    expect(overview).toHaveBeenCalledTimes(2);
    await cache.getOverview('AAPL');
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it('does not cache an unknown symbol', async () => {
    const { cache, earnings } = setup();
    earnings.mockRejectedValue(new UnknownSymbolError('ZZZZ'));
    await expect(cache.getEarnings('ZZZZ')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(cache.getEarnings('ZZZZ')).rejects.toBeInstanceOf(UnknownSymbolError);
    expect(earnings).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('shares one upstream call between concurrent identical requests, and still drops a shared failure', async () => {
    const { cache, overview } = setup();
    overview.mockRejectedValueOnce(new Error('boom'));
    const results = await Promise.allSettled([cache.getOverview('AAPL'), cache.getOverview('AAPL')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(overview).toHaveBeenCalledTimes(1);
    await cache.getOverview('AAPL');
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it('keys by symbol case-insensitively, and by statement and period', async () => {
    const { cache, overview, statements } = setup();
    await cache.getOverview('aapl');
    await cache.getOverview(' AAPL ');
    expect(overview).toHaveBeenCalledTimes(1);
    await cache.getStatements('AAPL', 'income', 'annual');
    await cache.getStatements('AAPL', 'income', 'quarter');
    await cache.getStatements('AAPL', 'balance', 'annual');
    await cache.getStatements('MSFT', 'income', 'annual');
    expect(statements).toHaveBeenCalledTimes(4);
  });

  it('bounds its memory', async () => {
    const { cache } = setup();
    for (let i = 0; i < MAX_CACHE_ENTRIES + 20; i++) await cache.getEarnings(`S${i}`);
    expect(cache.size).toBe(MAX_CACHE_ENTRIES);
  });

  it('reports the availability of the provider it wraps', () => {
    const inner: FundamentalsProvider = { available: false, getOverview: vi.fn(), getStatements: vi.fn(), getEarnings: vi.fn() };
    expect(new CachedFundamentalsProvider(inner).available).toBe(false);
  });
});
