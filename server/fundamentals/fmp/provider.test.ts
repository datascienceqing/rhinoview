/**
 * FMP provider against the RECORDED responses (server/fundamentals/__fixtures__/fmp),
 * through the real FmpClient. One describe per invariant of server/fundamentals/types.ts.
 */
import { describe, expect, it } from 'vitest';
import type { StatementRow } from '@shared/types';
import { RateLimitedError, UpstreamUnauthorizedError } from '../../provider/errors';
import { FmpPaymentRequiredError, FmpUpstreamError } from '../../market/fmp/client';
import { UnknownSymbolError } from '../../market/types';
import { createFixtureFundamentals } from './fixtureSource';
import { INTEREST_COST_SHARE_THRESHOLD, grossMarginIsInterestSpread } from './mapper';
import type { FmpStatementRow } from './schemas';
import { fixtureFetch, fixtureRows, json, providerOver, readFixture, TEST_KEY } from './testing';

const PAYMENT_BODY = "Restricted Endpoint: This endpoint is not available under your current subscription";
const gated = () => json(PAYMENT_BODY, 402);
// The measured body of a restricted SYMBOL (the client reads its scope from the text).
const SYMBOL_BODY = "Premium Query Parameter: 'symbol' is not available under your current subscription";
const symbolGated = () => json(SYMBOL_BODY, 402);

type Row = Record<string, unknown>;
const ttm = (symbol: string, name: string): Row => fixtureRows(symbol, name)[0] as Row;

function lineSum(rows: StatementRow[], key: string): number {
  return rows.reduce((acc, r) => acc + (r.lines[key] ?? 0), 0);
}

describe('invariant 1 — null, never zero; pass through what FMP supplies', () => {
  it('decides an unknown symbol from the EMPTY profile array and stops there', async () => {
    const fetch = fixtureFetch(); // ZZZZ has no fixture: every endpoint answers []
    await expect(providerOver(fetch).getOverview('ZZZZ')).rejects.toBeInstanceOf(UnknownSymbolError);
    expect(fetch.paths()).toEqual(['/profile']);
  });

  it('reports the symbol as the caller spelled it in UnknownSymbolError', async () => {
    await expect(providerOver(fixtureFetch()).getOverview('zzzz')).rejects.toMatchObject({ symbol: 'zzzz' });
  });

  it('treats a symbol-scope 402 on the profile as an unknown symbol, on all three methods', async () => {
    const fetch = fixtureFetch({ '/profile': symbolGated });
    const provider = providerOver(fetch);
    await expect(provider.getOverview('BRK-B')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(provider.getStatements('BRK-B', 'income', 'annual')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(provider.getEarnings('BRK-B')).rejects.toBeInstanceOf(UnknownSymbolError);
    expect(fetch.paths()).toEqual(['/profile', '/profile', '/profile']);
  });

  it('does NOT treat an endpoint-scope HTTP 402 on the profile as an unknown symbol', async () => {
    const provider = providerOver(fixtureFetch({ '/profile': gated }));
    const err = await provider.getOverview('AAPL').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnknownSymbolError);
    expect(err).toBeInstanceOf(FmpPaymentRequiredError);
    expect(err).toBeInstanceOf(UpstreamUnauthorizedError); // the route maps this to UNAUTHORIZED
  });

  it('applies the same unknown-symbol rule before statements and earnings', async () => {
    const fetch = fixtureFetch();
    const provider = providerOver(fetch);
    await expect(provider.getStatements('ZZZZ', 'income', 'annual')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(provider.getEarnings('ZZZZ')).rejects.toBeInstanceOf(UnknownSymbolError);
    expect(fetch.paths()).toEqual(['/profile', '/profile']);
  });

  it('passes JPM gross margin 0.626 through unchanged, although it is not meaningful for a bank', async () => {
    const o = await createFixtureFundamentals().getOverview('JPM');
    expect(o.metrics.grossMargin).toBe(ttm('JPM', 'ratios-ttm').grossProfitMarginTTM);
    expect(o.metrics.grossMargin).toBeCloseTo(0.626, 3);
  });

  it('passes RIVN negative P/E -5.54 through unchanged', async () => {
    const o = await createFixtureFundamentals().getOverview('RIVN');
    expect(o.metrics.peRatio).toBe(ttm('RIVN', 'ratios-ttm').priceToEarningsRatioTTM);
    expect(o.metrics.peRatio).toBeCloseTo(-5.54, 2);
    expect(o.metrics.evToEbitda).toBeLessThan(0);
    expect(o.metrics.returnOnEquity).toBeLessThan(0);
  });

  it('passes a supplied 0 through as 0 (AAPL interest coverage)', async () => {
    const o = await createFixtureFundamentals().getOverview('AAPL');
    expect(ttm('AAPL', 'ratios-ttm').interestCoverageRatioTTM).toBe(0);
    expect(o.metrics.interestCoverage).toBe(0);
  });

  it('maps a field FMP omits, or sends as null, to null and never to 0', async () => {
    const fetch = fixtureFetch({
      '/ratios-ttm': () => json([{ symbol: 'AAPL', grossProfitMarginTTM: null }]),
      '/key-metrics-ttm': () => json([{ symbol: 'AAPL' }]),
    });
    const o = await providerOver(fetch).getOverview('AAPL');
    expect(o.metrics.grossMargin).toBeNull();
    expect(o.metrics.peRatio).toBeNull();
    expect(o.metrics.returnOnEquity).toBeNull();
    expect(o.metrics.dividendYield).toBeNull();
    expect(Object.values(o.metrics).every((v) => v === null)).toBe(true);
    expect(o.unavailable).toEqual([]); // the endpoints answered; the fields are just absent
  });

  it('maps absent profile text to null, not an empty string', async () => {
    const fetch = fixtureFetch({
      '/profile': () => json([{ symbol: 'AAPL', companyName: 'Apple Inc.', currency: 'USD', website: '', ceo: null, fullTimeEmployees: 'n/a' }]),
    });
    const { profile } = await providerOver(fetch).getOverview('AAPL');
    expect(profile).toMatchObject({ website: null, ceo: null, employees: null, sector: null, ipoDate: null, marketCap: null });
  });

  it('reads employees from the string FMP sends', async () => {
    const { profile } = await createFixtureFundamentals().getOverview('AAPL');
    expect(profile.employees).toBe(166000);
    expect(profile.ipoDate).toBe('1980-12-12');
    expect(profile.exchange).toBe('NASDAQ');
  });

  it('maps a statement line the issuer does not report to null', async () => {
    const rows = fixtureRows('AAPL', 'income-annual').map((r) => {
      const copy = { ...(r as Row) };
      delete copy.researchAndDevelopmentExpenses;
      copy.interestExpense = null;
      return copy;
    });
    const fetch = fixtureFetch({ '/income-statement': () => json(rows) });
    const res = await providerOver(fetch).getStatements('AAPL', 'income', 'annual');
    expect(res.rows[0]?.lines.researchAndDevelopmentExpenses).toBeNull();
    expect(res.rows[0]?.lines.interestExpense).toBeNull();
    expect(res.rows[0]?.lines.revenue).toBe(rows[0]?.revenue);
  });
});

describe('invariant 2 — ratios are fractions', () => {
  it('copies margins, yield, payout and returns unscaled', async () => {
    const o = await createFixtureFundamentals().getOverview('AAPL');
    const ratios = ttm('AAPL', 'ratios-ttm');
    const km = ttm('AAPL', 'key-metrics-ttm');
    expect(o.metrics.grossMargin).toBe(ratios.grossProfitMarginTTM);
    expect(o.metrics.grossMargin).toBeCloseTo(0.4865, 3); // 48.65%, not 48.65
    expect(o.metrics.operatingMargin).toBe(ratios.operatingProfitMarginTTM);
    expect(o.metrics.netMargin).toBe(ratios.netProfitMarginTTM);
    expect(o.metrics.dividendYield).toBe(ratios.dividendYieldTTM);
    expect(o.metrics.dividendYield).toBeCloseTo(0.0032, 4);
    expect(o.metrics.payoutRatio).toBe(ratios.dividendPayoutRatioTTM);
    expect(o.metrics.returnOnEquity).toBe(km.returnOnEquityTTM);
    expect(o.metrics.returnOnInvestedCapital).toBe(km.returnOnInvestedCapitalTTM);
  });

  it('reads the FMP fields whose names are not the obvious ones', async () => {
    const o = await createFixtureFundamentals().getOverview('MSFT');
    const ratios = ttm('MSFT', 'ratios-ttm');
    expect(o.metrics.peRatio).toBe(ratios.priceToEarningsRatioTTM);
    expect(o.metrics.pegRatio).toBe(ratios.priceToEarningsGrowthRatioTTM);
    expect(o.metrics.debtToEquity).toBe(ratios.debtToEquityRatioTTM);
    expect(o.metrics.evToEbitda).toBe(ttm('MSFT', 'key-metrics-ttm').evToEBITDATTM);
  });

  it('copies analyst targets and counts as supplied', async () => {
    const o = await createFixtureFundamentals().getOverview('AAPL');
    expect(o.analyst).toEqual({
      targetHigh: 400, targetLow: 245, targetConsensus: 341.68, targetMedian: 357.5,
      strongBuy: 1, buy: 70, hold: 32, sell: 9, strongSell: 0, consensus: 'Buy',
    });
    expect(o.scores).toEqual({ piotroskiScore: 9, altmanZScore: ttm('AAPL', 'financial-scores').altmanZScore });
  });
});

describe('invariant 3 — fiscal labels come from the provider', () => {
  it('labels MSFT quarters by fiscal year, not by the calendar year of the period end', async () => {
    const res = await createFixtureFundamentals().getStatements('MSFT', 'income', 'quarter');
    const byEnd = new Map(res.rows.map((r) => [r.periodEnd, r]));
    expect(byEnd.get('2025-09-30')).toMatchObject({ fiscalYear: 2026, fiscalPeriod: 'Q1' }); // calendar 2025
    expect(byEnd.get('2025-12-31')).toMatchObject({ fiscalYear: 2026, fiscalPeriod: 'Q2' });
    expect(byEnd.get('2026-06-30')).toMatchObject({ fiscalYear: 2026, fiscalPeriod: 'Q4' });
  });

  it('labels MSFT annual rows FY with the year the fiscal year ends', async () => {
    const res = await createFixtureFundamentals().getStatements('MSFT', 'income', 'annual');
    expect(res.rows[0]).toMatchObject({ fiscalYear: 2026, fiscalPeriod: 'FY', periodEnd: '2026-06-30' });
  });

  it('copies whatever fiscal year FMP supplies, even one a calendar rule would not give', async () => {
    const rows = fixtureRows('AAPL', 'income-quarter').map((r) => ({ ...(r as Row), fiscalYear: '1999', period: 'Q2' }));
    const res = await providerOver(fixtureFetch({ '/income-statement': () => json(rows) })).getStatements('AAPL', 'income', 'quarter');
    expect(res.rows.every((r) => r.fiscalYear === 1999 && r.fiscalPeriod === 'Q2')).toBe(true);
  });

  it('turns FMP\'s string fiscal year into a number', async () => {
    const res = await createFixtureFundamentals().getStatements('AAPL', 'income', 'annual');
    expect(typeof res.rows[0]?.fiscalYear).toBe('number');
  });
});

describe('invariant 4 — currency is explicit (TSM reports in TWD, trades in USD)', () => {
  it('reports TWD as the reporting currency and USD as the listing currency', async () => {
    const o = await createFixtureFundamentals().getOverview('TSM');
    expect(o.reportedCurrency).toBe('TWD');
    expect(o.profile.currency).toBe('USD');
  });

  it('stamps every TSM statement row with TWD', async () => {
    const provider = createFixtureFundamentals();
    for (const statement of ['income', 'balance', 'cashflow'] as const) {
      for (const period of ['annual', 'quarter'] as const) {
        const res = await provider.getStatements('TSM', statement, period);
        expect(res.rows.length).toBeGreaterThan(0);
        expect(res.rows.every((r) => r.reportedCurrency === 'TWD')).toBe(true);
      }
    }
  });

  it('uses FMP\'s own P/E and per-share values and never divides a USD price by TWD EPS', async () => {
    const o = await createFixtureFundamentals().getOverview('TSM');
    const price = ttm('TSM', 'profile').price as number;
    expect(o.metrics.peRatio).toBe(ttm('TSM', 'ratios-ttm').priceToEarningsRatioTTM);
    expect(o.metrics.epsDiluted).toBe(ttm('TSM', 'ratios-ttm').netIncomePerShareTTM); // TWD per share
    // price / EPS would be about 1.1; the provider's P/E is about 29.
    expect(price / (o.metrics.epsDiluted as number)).toBeLessThan(2);
    expect(o.metrics.peRatio).toBeGreaterThan(20);
  });

  it('falls back to the income statement for the reporting currency when scores are gated', async () => {
    const o = await providerOver(fixtureFetch({ '/financial-scores': gated })).getOverview('TSM');
    expect(o.reportedCurrency).toBe('TWD');
    expect(o.unavailable).toEqual(['scores']);
  });
});

describe('invariant 5 — flows sum to the year, stocks do not', () => {
  it.each(['AAPL', 'MSFT'])('%s: four quarterly revenue, net income and operating cash flow sum EXACTLY to the fiscal year', async (symbol) => {
    const provider = createFixtureFundamentals();
    const [qi, ai, qc, ac] = await Promise.all([
      provider.getStatements(symbol, 'income', 'quarter'),
      provider.getStatements(symbol, 'income', 'annual'),
      provider.getStatements(symbol, 'cashflow', 'quarter'),
      provider.getStatements(symbol, 'cashflow', 'annual'),
    ]);
    const fy = 2025;
    const quarters = (res: typeof qi) => res.rows.filter((r) => r.fiscalYear === fy);
    expect(quarters(qi)).toHaveLength(4);
    const annualIncome = ai.rows.find((r) => r.fiscalYear === fy);
    const annualCash = ac.rows.find((r) => r.fiscalYear === fy);
    expect(lineSum(quarters(qi), 'revenue')).toBe(annualIncome?.lines.revenue);
    expect(lineSum(quarters(qi), 'netIncome')).toBe(annualIncome?.lines.netIncome);
    expect(lineSum(quarters(qc), 'operatingCashFlow')).toBe(annualCash?.lines.operatingCashFlow);
  });

  it.each(['AAPL', 'MSFT'])('%s: the balance-sheet fiscal-year value is the Q4 value, not a sum', async (symbol) => {
    const provider = createFixtureFundamentals();
    const [q, a] = await Promise.all([
      provider.getStatements(symbol, 'balance', 'quarter'),
      provider.getStatements(symbol, 'balance', 'annual'),
    ]);
    const q4 = q.rows.find((r) => r.fiscalYear === 2025 && r.fiscalPeriod === 'Q4');
    const fy = a.rows.find((r) => r.fiscalYear === 2025);
    expect(q4).toBeDefined();
    expect(fy?.lines.totalAssets).toBe(q4?.lines.totalAssets);
    expect(fy?.lines.totalEquity).toBe(q4?.lines.totalEquity);
    // Summing the four quarters would be about four times the stock.
    expect(lineSum(q.rows.filter((r) => r.fiscalYear === 2025), 'totalAssets')).toBeGreaterThan(3 * (fy?.lines.totalAssets ?? 0));
  });

  it('copies each statement\'s curated lines, in order, with labels', async () => {
    const res = await createFixtureFundamentals().getStatements('AAPL', 'cashflow', 'annual');
    expect(res.lineItems.map((l) => l.key)).toContain('freeCashFlow');
    expect(res.lineItems.every((l) => l.label.length > 0)).toBe(true);
    expect(res.lineItems.length).toBeGreaterThanOrEqual(10);
    expect(res.lineItems.length).toBeLessThanOrEqual(16);
    for (const row of res.rows) expect(Object.keys(row.lines)).toEqual(res.lineItems.map((l) => l.key));
  });

  it('has a value for every curated line of every recorded statement', async () => {
    const provider = createFixtureFundamentals();
    for (const symbol of ['AAPL', 'MSFT', 'JPM', 'TSM', 'RIVN']) {
      for (const statement of ['income', 'balance', 'cashflow'] as const) {
        const res = await provider.getStatements(symbol, statement, 'quarter');
        for (const row of res.rows) expect(Object.values(row.lines).every((v) => v !== null), `${symbol} ${statement}`).toBe(true);
      }
    }
  });
});

describe('invariant 6 — newest first; annual <= 10, quarterly <= 8', () => {
  const shuffled = (rows: Row[]) => [...rows].sort((a, b) => (a.date as string).localeCompare(b.date as string)); // oldest first

  it('sorts statement rows newest first even when FMP answers oldest first', async () => {
    const fetch = fixtureFetch({ '/income-statement': () => json(shuffled(fixtureRows('MSFT', 'income-annual'))) });
    const res = await providerOver(fetch).getStatements('MSFT', 'income', 'annual');
    const ends = res.rows.map((r) => r.periodEnd);
    expect(ends).toEqual([...ends].sort().reverse());
    expect(res.rows[0]?.periodEnd).toBe('2026-06-30');
  });

  it('sorts earnings newest first, upcoming report first', async () => {
    const fetch = fixtureFetch({ '/earnings': () => json(shuffled(fixtureRows('AAPL', 'earnings'))) });
    const res = await providerOver(fetch).getEarnings('AAPL');
    const dates = res.events.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(res.events[0]).toMatchObject({ date: '2026-10-29', epsActual: null, revenueActual: null, epsEstimate: 1.99 });
    expect(res.events[1]).toMatchObject({ date: '2026-07-30', epsActual: 2.02, epsEstimate: 1.89 });
  });

  it('asks FMP for 10 annual and 8 quarterly rows', async () => {
    const fetch = fixtureFetch();
    const provider = providerOver(fetch);
    await provider.getStatements('AAPL', 'income', 'annual');
    await provider.getStatements('AAPL', 'income', 'quarter');
    const stmts = fetch.calls.filter((u) => u.pathname.endsWith('/income-statement'));
    expect(stmts.map((u) => [u.searchParams.get('period'), u.searchParams.get('limit')])).toEqual([['annual', '10'], ['quarter', '8']]);
  });

  it('cuts an over-long answer to 10 annual rows and 8 quarterly rows, keeping the newest', async () => {
    const many = (period: 'FY' | 'Q1') =>
      Array.from({ length: 15 }, (_, i) => ({
        ...(fixtureRows('AAPL', 'income-annual')[0] as Row),
        date: `${2030 - i}-09-30`,
        fiscalYear: String(2030 - i),
        period,
      }));
    const fetch = fixtureFetch({ '/income-statement': (u) => json(many(u.searchParams.get('period') === 'annual' ? 'FY' : 'Q1')) });
    const provider = providerOver(fetch);
    const annual = await provider.getStatements('AAPL', 'income', 'annual');
    const quarter = await provider.getStatements('AAPL', 'income', 'quarter');
    expect(annual.rows).toHaveLength(10);
    expect(annual.rows[0]?.fiscalYear).toBe(2030);
    expect(quarter.rows).toHaveLength(8);
    expect(quarter.rows[0]?.fiscalYear).toBe(2030);
  });

  it('returns the 10 recorded annual and 8 recorded quarterly rows, and fewer for a young company', async () => {
    const provider = createFixtureFundamentals();
    expect((await provider.getStatements('AAPL', 'balance', 'annual')).rows).toHaveLength(10);
    expect((await provider.getStatements('AAPL', 'balance', 'quarter')).rows).toHaveLength(8);
    expect((await provider.getStatements('RIVN', 'balance', 'annual')).rows).toHaveLength(7);
  });
});

describe('invariant 7 — partial success in the overview', () => {
  it('succeeds with every section when nothing is gated', async () => {
    const o = await createFixtureFundamentals().getOverview('AAPL');
    expect(o.unavailable).toEqual([]);
    expect(o.profile).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD' });
    expect(o.reportedCurrency).toBe('USD');
  });

  it('lists a gated metrics section (both TTM endpoints 402) and nulls its fields', async () => {
    const fetch = fixtureFetch({ '/ratios-ttm': gated, '/key-metrics-ttm': gated });
    const o = await providerOver(fetch).getOverview('AAPL');
    expect(o.unavailable).toEqual(['metrics']);
    expect(Object.values(o.metrics).every((v) => v === null)).toBe(true);
    expect(o.scores.piotroskiScore).toBe(9);
    expect(o.analyst.consensus).toBe('Buy');
  });

  it('keeps the half of the metrics it has when only one TTM endpoint is gated', async () => {
    const o = await providerOver(fixtureFetch({ '/key-metrics-ttm': gated })).getOverview('AAPL');
    expect(o.unavailable).toEqual([]);
    expect(o.metrics.peRatio).not.toBeNull();
    expect(o.metrics.returnOnEquity).toBeNull();
  });

  it('lists scores and analyst when they are gated or empty, and still succeeds', async () => {
    const fetch = fixtureFetch({
      '/financial-scores': gated,
      '/price-target-consensus': () => json([]),
      '/grades-consensus': gated,
    });
    const o = await providerOver(fetch).getOverview('AAPL');
    expect(o.unavailable).toEqual(['scores', 'analyst']);
    expect(o.scores).toEqual({ piotroskiScore: null, altmanZScore: null });
    expect(Object.values(o.analyst).every((v) => v === null)).toBe(true);
    expect(o.metrics.peRatio).not.toBeNull();
  });

  it('lists all three gated sections and still returns the profile', async () => {
    const fetch = fixtureFetch({
      '/ratios-ttm': gated, '/key-metrics-ttm': gated, '/financial-scores': gated,
      '/price-target-consensus': gated, '/grades-consensus': gated,
    });
    const o = await providerOver(fetch).getOverview('MSFT');
    expect(o.unavailable).toEqual(['metrics', 'scores', 'analyst']);
    expect(o.profile.name).toBe('Microsoft Corporation');
  });

  it('fails the whole overview when the profile is gated', async () => {
    await expect(providerOver(fixtureFetch({ '/profile': gated })).getOverview('AAPL')).rejects.toBeInstanceOf(FmpPaymentRequiredError);
  });

  it('does NOT hide a transient failure as "unavailable": a 500 in a section fails the request', async () => {
    const provider = providerOver(fixtureFetch({ '/ratios-ttm': () => json('boom', 500) }));
    await expect(provider.getOverview('AAPL')).rejects.toBeInstanceOf(FmpUpstreamError);
  });

  it('does NOT hide throttling as "unavailable": a 429 in a section fails the request', async () => {
    const provider = providerOver(fixtureFetch({ '/grades-consensus': () => json('slow down', 429) }));
    await expect(provider.getOverview('AAPL')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('fails with a fixed, body-free message when FMP changes shape', async () => {
    const provider = providerOver(fixtureFetch({ '/profile': () => json([{ symbol: 'AAPL', companyName: 12345, secret: 'SHOULD-NOT-APPEAR' }]) }));
    const err = (await provider.getOverview('AAPL').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(FmpUpstreamError);
    expect(err.message).toBe('FMP /profile returned an unexpected shape');
    expect(`${err.message}${err.stack}`).not.toContain('SHOULD-NOT-APPEAR');
    expect(`${err.message}${err.stack}`).not.toContain(TEST_KEY);
  });

  it('takes asOf from the injected clock, in seconds', async () => {
    const o = await providerOver(fixtureFetch(), () => 1_790_000_123_456).getOverview('AAPL');
    expect(o.asOf).toBe(1_790_000_123);
  });
});

describe('invariant 8 — gated data is not derived', () => {
  it('has recorded 402 bodies for quarterly ratios and key metrics', () => {
    expect(readFixture('_gated', 'ratios-quarter').status).toBe(402);
    expect(readFixture('_gated', 'key-metrics-quarter').status).toBe(402);
  });

  it('only ever calls the TTM ratio endpoints, never quarterly ratios or key metrics', async () => {
    const fetch = fixtureFetch();
    const provider = providerOver(fetch);
    await provider.getOverview('AAPL');
    for (const statement of ['income', 'balance', 'cashflow'] as const) {
      for (const period of ['annual', 'quarter'] as const) await provider.getStatements('AAPL', statement, period);
    }
    await provider.getEarnings('AAPL');
    const allowed = new Set([
      '/profile', '/ratios-ttm', '/key-metrics-ttm', '/financial-scores', '/price-target-consensus', '/grades-consensus',
      '/income-statement', '/balance-sheet-statement', '/cash-flow-statement', '/earnings',
    ]);
    expect(fetch.paths().filter((p) => !allowed.has(p))).toEqual([]);
    expect(fetch.paths()).not.toContain('/ratios');
    expect(fetch.paths()).not.toContain('/key-metrics');
  });

  it('adds no ratio to a statements response', async () => {
    const res = await createFixtureFundamentals().getStatements('AAPL', 'income', 'quarter');
    expect(res.lineItems.map((l) => l.key).filter((k) => /ratio|margin|peRatio/i.test(k))).toEqual([]);
  });

  it('does not compute a P/E: it is the TTM value from FMP even when it disagrees with price / EPS', async () => {
    const fetch = fixtureFetch({ '/ratios-ttm': () => json([{ symbol: 'AAPL', priceToEarningsRatioTTM: 77.77, netIncomePerShareTTM: 1 }]) });
    const o = await providerOver(fetch).getOverview('AAPL');
    expect(o.metrics.peRatio).toBe(77.77);
  });
});

describe('errors and secrets', () => {
  it('maps a 429 to RateLimitedError', async () => {
    await expect(providerOver(fixtureFetch({ '/profile': () => json('x', 429) })).getEarnings('AAPL')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('puts no API key in any request path it logs or reports, and sends it only as the apikey parameter', async () => {
    const fetch = fixtureFetch();
    await providerOver(fetch).getOverview('AAPL');
    for (const url of fetch.calls) {
      expect(url.searchParams.get('apikey')).toBe(TEST_KEY);
      expect(url.pathname).not.toContain(TEST_KEY);
    }
  });
});

describe('the mapper over every recorded symbol', () => {
  it.each(['AAPL', 'MSFT', 'JPM', 'TSM', 'RIVN'])('%s: overview, six statements and earnings all map', async (symbol) => {
    const provider = createFixtureFundamentals();
    const o = await provider.getOverview(symbol);
    expect(o.profile.symbol).toBe(symbol);
    expect(o.unavailable).toEqual([]);
    for (const statement of ['income', 'balance', 'cashflow'] as const) {
      for (const period of ['annual', 'quarter'] as const) {
        const res = await provider.getStatements(symbol, statement, period);
        expect(res.symbol).toBe(symbol);
        expect(res.rows.length).toBeGreaterThan(0);
      }
    }
    expect((await provider.getEarnings(symbol)).events.length).toBeGreaterThan(0);
  });

  it('treats a symbol without a fixture as unknown, like FMP does', async () => {
    await expect(createFixtureFundamentals().getOverview('NOPE')).rejects.toBeInstanceOf(UnknownSymbolError);
  });
});

describe('gross margin of a lender (grossMarginNotMeaningful)', () => {
  // Only the two fields the rule reads; the cast keeps the test about the rule.
  const row = (costOfRevenue: unknown, interestExpense: unknown) =>
    ({ costOfRevenue, interestExpense }) as unknown as FmpStatementRow;

  it('flags JPM, whose cost of revenue is mostly interest (recorded fixture)', async () => {
    expect((await createFixtureFundamentals().getOverview('JPM')).grossMarginNotMeaningful).toBe(true);
  });

  it('does not flag the non-lenders in the fixtures', async () => {
    for (const s of ['AAPL', 'MSFT', 'TSM', 'RIVN']) {
      expect((await createFixtureFundamentals().getOverview(s)).grossMarginNotMeaningful, s).toBe(false);
    }
  });

  it('separates the measured groups: lenders 0.43 and up, everyone else 0.09 and down', () => {
    expect(grossMarginIsInterestSpread(row(100, 87))).toBe(true); // JPM 0.87
    expect(grossMarginIsInterestSpread(row(100, 43))).toBe(true); // COF 0.43
    expect(grossMarginIsInterestSpread(row(100, 7))).toBe(false); // V 0.07
    expect(grossMarginIsInterestSpread(row(100, 9))).toBe(false); // AON 0.09
  });

  it('flags a share exactly at the threshold', () => {
    expect(grossMarginIsInterestSpread(row(100, INTEREST_COST_SHARE_THRESHOLD * 100))).toBe(true);
  });

  it('treats a missing or zero cost of revenue as no evidence (MA reports none)', () => {
    expect(grossMarginIsInterestSpread(row(0, 50))).toBe(false);
    expect(grossMarginIsInterestSpread(row(null, 50))).toBe(false);
    expect(grossMarginIsInterestSpread(row(100, null))).toBe(false);
    expect(grossMarginIsInterestSpread(null)).toBe(false);
  });

  it('reads the size of the interest expense, whatever its sign', () => {
    expect(grossMarginIsInterestSpread(row(100, -87))).toBe(true);
  });
});
