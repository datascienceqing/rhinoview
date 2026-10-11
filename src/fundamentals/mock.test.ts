/** Guards mocks/fundamentals.ts: contract-shaped, built from the (synthetic) FMP fixtures, contract errors. */
import { describe, expect, it } from 'vitest';
import type { EarningsResponse, FundamentalsOverview, StatementsResponse } from '@shared/types';
import { DataError, apiRequest } from '../data';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof DataError ? e.code : 'thrown';
  }
};

describe('fundamentals mock', () => {
  it('serves an overview with fractions and the reporting currency', async () => {
    const o = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'aapl' } });
    expect(o.profile.symbol).toBe('AAPL');
    expect(o.metrics.grossMargin).toBeCloseTo(0.44, 3);
    expect(o.unavailable).toEqual([]);
    const tsm = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'TSM' } });
    expect(tsm.reportedCurrency).toBe('TWD');
    expect(tsm.profile.currency).toBe('USD');
  });

  it('keeps the RIVN and JPM raw values of the fixtures', async () => {
    const rivn = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'RIVN' } });
    expect(rivn.metrics.peRatio).toBeLessThan(0);
    const jpm = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'JPM' } });
    expect(jpm.profile.sector).toBe('Financial Services');
    expect(jpm.metrics.grossMargin).toBeCloseTo(0.6, 3);
  });

  it('serves statements newest first with provider fiscal labels', async () => {
    const s = await apiRequest<StatementsResponse>('/fundamentals/statements', {
      params: { symbol: 'MSFT', statement: 'income', period: 'quarter' },
    });
    expect(s.rows).toHaveLength(8);
    expect(s.rows[0]).toMatchObject({ fiscalYear: 2026, fiscalPeriod: 'Q4', periodEnd: '2026-06-30' });
    expect(s.rows.at(-1)).toMatchObject({ fiscalYear: 2025, fiscalPeriod: 'Q1', periodEnd: '2024-09-30' });
    expect(s.lineItems.map((l) => l.key)).toContain('revenue');
    expect(Object.keys(s.rows[0]?.lines ?? {})).toEqual(s.lineItems.map((l) => l.key));
  });

  it('serves earnings with an upcoming event first', async () => {
    const e = await apiRequest<EarningsResponse>('/fundamentals/earnings', { params: { symbol: 'AAPL' } });
    expect(e.events[0]).toMatchObject({ epsActual: null, revenueActual: null });
    expect(e.events[1]?.epsActual).not.toBeNull();
  });

  it('answers UNKNOWN_SYMBOL for an unknown symbol and BAD_REQUEST for bad params', async () => {
    expect(await code(apiRequest('/fundamentals/overview', { params: { symbol: 'ZZZZ' } }))).toBe('UNKNOWN_SYMBOL');
    expect(await code(apiRequest('/fundamentals/earnings', { params: { symbol: '' } }))).toBe('BAD_REQUEST');
    expect(
      await code(apiRequest('/fundamentals/statements', { params: { symbol: 'AAPL', statement: 'x', period: 'annual' } })),
    ).toBe('BAD_REQUEST');
    expect(
      await code(apiRequest('/fundamentals/statements', { params: { symbol: 'AAPL', statement: 'income', period: 'weekly' } })),
    ).toBe('BAD_REQUEST');
  });
});

describe('fundamentals mock: earnings limit', () => {
  const get = (query: string) =>
    apiRequest<EarningsResponse>(`/fundamentals/earnings?${query}`);

  it('defaults to the newest 40 events', async () => {
    const e = await apiRequest<EarningsResponse>('/fundamentals/earnings', { params: { symbol: 'AAPL' } });
    expect(e.events).toHaveLength(40);
    expect(e.events[0]?.date).toBe('2026-10-29');
  });

  it('returns the newest `limit` events, and fewer when the list is shorter', async () => {
    expect((await get('symbol=AAPL&limit=3')).events.map((x) => x.date)).toEqual(['2026-10-29', '2026-07-30', '2026-04-30']);
    expect((await get('symbol=AAPL&limit=400')).events).toHaveLength(165);
    expect((await get('symbol=RIVN&limit=400')).events).toHaveLength(28);
  });

  it.each(['limit=0', 'limit=401', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'limit=%2010', 'limit=5&limit=6'])(
    'rejects %s with BAD_REQUEST',
    async (bad) => {
      expect(await code(get(`symbol=AAPL&${bad}`))).toBe('BAD_REQUEST');
    },
  );
});
