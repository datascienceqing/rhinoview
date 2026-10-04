/** Guards mocks/fundamentals.ts: contract-shaped, real fixtures, contract errors. */
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
    expect(o.metrics.grossMargin).toBeCloseTo(0.4865, 3);
    expect(o.unavailable).toEqual([]);
    const tsm = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'TSM' } });
    expect(tsm.reportedCurrency).toBe('TWD');
    expect(tsm.profile.currency).toBe('USD');
  });

  it('keeps the measured RIVN and JPM raw values', async () => {
    const rivn = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'RIVN' } });
    expect(rivn.metrics.peRatio).toBeLessThan(0);
    const jpm = await apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol: 'JPM' } });
    expect(jpm.profile.sector).toBe('Financial Services');
    expect(jpm.metrics.grossMargin).toBeCloseTo(0.626, 3);
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
