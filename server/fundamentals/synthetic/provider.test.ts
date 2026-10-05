/**
 * Synthetic provider: invariant 10 (it obeys 1-6 and is deterministic), checked over the
 * whole synthetic universe, not a hand-picked symbol.
 */
import { describe, expect, it } from 'vitest';
import type { StatementKind, StatementRow } from '@shared/types';
import { UNIVERSE } from '../../market/universe';
import { UnknownSymbolError } from '../../market/types';
import { MAX_STATEMENT_ROWS } from '../lineItems';
import { SyntheticFundamentalsProvider } from './provider';

const NOW = () => 1_790_000_000_000;
const provider = new SyntheticFundamentalsProvider({ now: NOW });
const companies = UNIVERSE.filter((m) => m.type === 'CS');
const etfs = UNIVERSE.filter((m) => m.type === 'ETF');

/** Lines that are not flows: per-share and share counts. */
const NOT_SUMMED = new Set(['epsDiluted', 'weightedAverageShsOutDil']);

/** A young listing may legitimately have no complete fiscal year yet; established ones always do. */
const established = (symbol: string) => (UNIVERSE.find((m) => m.symbol === symbol)?.listedAt ?? 0) < Date.parse('2023-01-01') / 1000;

const year = (iso: string) => Number(iso.slice(0, 4));
const month = (iso: string) => Number(iso.slice(5, 7));

async function allStatements(symbol: string, statement: StatementKind) {
  const [annual, quarter] = await Promise.all([
    provider.getStatements(symbol, statement, 'annual'),
    provider.getStatements(symbol, statement, 'quarter'),
  ]);
  return { annual: annual.rows, quarter: quarter.rows, lineItems: annual.lineItems };
}

/** Fiscal years whose four quarters are all inside the 8-quarter window. */
function completeYears(quarters: StatementRow[]): number[] {
  const years = new Set(quarters.map((q) => q.fiscalYear));
  return [...years].filter((y) => quarters.filter((q) => q.fiscalYear === y).length === 4);
}

describe('determinism', () => {
  it('returns identical data for the same symbol from two instances', async () => {
    const other = new SyntheticFundamentalsProvider({ now: NOW });
    for (const symbol of ['AAPL', 'JPM', 'KRNL', 'SPY']) {
      expect(await other.getOverview(symbol)).toEqual(await provider.getOverview(symbol));
      expect(await other.getEarnings(symbol)).toEqual(await provider.getEarnings(symbol));
      expect(await other.getStatements(symbol, 'income', 'quarter')).toEqual(await provider.getStatements(symbol, 'income', 'quarter'));
    }
  });

  it('returns the same overview every time it is asked (no hidden random stream)', async () => {
    const a = await provider.getOverview('MSFT');
    const b = await provider.getOverview('MSFT');
    expect(b).toEqual(a);
  });

  it('gives different symbols different numbers', async () => {
    const a = await provider.getStatements('AAPL', 'income', 'annual');
    const b = await provider.getStatements('MSFT', 'income', 'annual');
    expect(a.rows[0]?.lines.revenue).not.toBe(b.rows[0]?.lines.revenue);
  });

  it('takes only asOf from the clock', async () => {
    const later = new SyntheticFundamentalsProvider({ now: () => 1_800_000_000_000 });
    const a = await provider.getOverview('AAPL');
    const b = await later.getOverview('AAPL');
    expect(a.asOf).toBe(1_790_000_000);
    expect(b.asOf).toBe(1_800_000_000);
    expect({ ...b, asOf: a.asOf }).toEqual(a);
  });
});

describe('unknown symbols and ETFs', () => {
  it('throws UnknownSymbolError for a symbol outside the universe, from every method', async () => {
    await expect(provider.getOverview('ZZZZ')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(provider.getStatements('ZZZZ', 'income', 'annual')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(provider.getEarnings('ZZZZ')).rejects.toBeInstanceOf(UnknownSymbolError);
  });

  it('accepts any casing and returns the canonical symbol', async () => {
    expect((await provider.getStatements(' aapl ', 'income', 'annual')).symbol).toBe('AAPL');
    expect((await provider.getOverview('brk.b')).profile.symbol).toBe('BRK.B');
  });

  it.each(etfs.map((m) => m.symbol))('%s: an ETF has a profile but no financials', async (symbol) => {
    const o = await provider.getOverview(symbol);
    expect(o.unavailable).toEqual(['metrics', 'scores', 'analyst']);
    expect(Object.values(o.metrics).every((v) => v === null)).toBe(true);
    expect(o.profile.marketCap).toBeNull();
    expect((await provider.getStatements(symbol, 'income', 'annual')).rows).toEqual([]);
    expect((await provider.getEarnings(symbol)).events).toEqual([]);
  });
});

describe('invariant 5 — flows sum exactly to the fiscal year; balance FY = Q4', () => {
  it.each(companies.map((m) => m.symbol))('%s: income and cash-flow flows sum exactly, in every complete fiscal year', async (symbol) => {
    for (const statement of ['income', 'cashflow'] as const) {
      const { annual, quarter, lineItems } = await allStatements(symbol, statement);
      const years = completeYears(quarter);
      if (established(symbol)) expect(years.length, `${symbol} ${statement}: a complete fiscal year in the window`).toBeGreaterThan(0);
      for (const fy of years) {
        const fyRow = annual.find((r) => r.fiscalYear === fy);
        expect(fyRow, `${symbol} FY${fy}`).toBeDefined();
        const qs = quarter.filter((r) => r.fiscalYear === fy);
        for (const { key } of lineItems) {
          if (NOT_SUMMED.has(key)) continue;
          const total = qs.reduce((acc, r) => acc + (r.lines[key] ?? NaN), 0);
          expect(total, `${symbol} ${statement} ${key} FY${fy}`).toBe(fyRow?.lines[key]);
        }
      }
    }
  });

  it.each(companies.map((m) => m.symbol))('%s: balance-sheet fiscal-year lines equal the Q4 lines', async (symbol) => {
    const { annual, quarter } = await allStatements(symbol, 'balance');
    let checked = 0;
    for (const fyRow of annual) {
      const q4 = quarter.find((r) => r.fiscalYear === fyRow.fiscalYear && r.fiscalPeriod === 'Q4');
      if (!q4) continue; // Q4 older than the 8-quarter window
      expect(fyRow.lines).toEqual(q4.lines);
      expect(fyRow.periodEnd).toBe(q4.periodEnd);
      checked++;
    }
    if (established(symbol)) expect(checked).toBeGreaterThan(0);
  });

  it('keeps the accounting identities in annual rows, because they are sums of exact quarters', async () => {
    for (const symbol of ['AAPL', 'JPM', 'TSLA']) {
      const { annual } = await allStatements(symbol, 'income');
      for (const r of annual) {
        const l = r.lines;
        expect(l.grossProfit).toBe((l.revenue ?? NaN) - (l.costOfRevenue ?? NaN));
        expect(l.operatingIncome).toBe((l.grossProfit ?? NaN) - (l.operatingExpenses ?? NaN));
        expect(l.netIncome).toBe((l.incomeBeforeTax ?? NaN) - (l.incomeTaxExpense ?? NaN));
      }
      const { annual: bs } = await allStatements(symbol, 'balance');
      for (const r of bs) {
        expect(r.lines.totalEquity).toBe((r.lines.totalAssets ?? NaN) - (r.lines.totalLiabilities ?? NaN));
        expect(r.lines.totalDebt).toBe((r.lines.shortTermDebt ?? NaN) + (r.lines.longTermDebt ?? NaN));
      }
    }
  });

  it('does not make annual EPS an exact sum of quarterly EPS (it is net income over average shares)', async () => {
    const { annual } = await allStatements('AAPL', 'income');
    const row = annual[0];
    const shares = row?.lines.weightedAverageShsOutDil ?? NaN;
    expect(row?.lines.epsDiluted).toBe(Math.round(((row?.lines.netIncome ?? NaN) / shares) * 100) / 100);
  });
});

describe('invariant 3 — fiscal labels follow the issuer, not the calendar', () => {
  it('uses a non-December fiscal year for some symbols, labelled consistently', async () => {
    let offCalendar = 0;
    for (const m of companies) {
      const { quarter, annual } = await allStatements(m.symbol, 'income');
      for (const r of quarter) {
        const label = r.fiscalYear - year(r.periodEnd);
        expect([0, 1]).toContain(label);
        if (label === 1) offCalendar++;
      }
      // Quarters step back one at a time: Q4, Q3, Q2, Q1, Q4 ...
      const order = quarter.map((r) => r.fiscalPeriod);
      for (let i = 1; i < order.length; i++) {
        const prev = Number(order[i - 1]?.slice(1));
        const cur = Number(order[i]?.slice(1));
        expect(cur).toBe(prev === 1 ? 4 : prev - 1);
      }
      // An annual row ends in the same month as its Q4, and says FY.
      for (const a of annual) {
        expect(a.fiscalPeriod).toBe('FY');
        expect(month(a.periodEnd) % 3).toBe(0);
      }
    }
    expect(offCalendar).toBeGreaterThan(0);
  });
});

describe('invariants 4 and 6 — currency, order, limits', () => {
  it('states USD on every row and in the overview', async () => {
    const o = await provider.getOverview('AAPL');
    expect(o.reportedCurrency).toBe('USD');
    const { annual, quarter } = await allStatements('AAPL', 'cashflow');
    expect([...annual, ...quarter].every((r) => r.reportedCurrency === 'USD')).toBe(true);
  });

  it.each(['income', 'balance', 'cashflow'] as const)('%s: newest first, annual <= 10, quarterly <= 8', async (statement) => {
    for (const m of companies) {
      const { annual, quarter } = await allStatements(m.symbol, statement);
      expect(annual.length).toBeLessThanOrEqual(MAX_STATEMENT_ROWS.annual);
      expect(quarter.length).toBeLessThanOrEqual(MAX_STATEMENT_ROWS.quarter);
      for (const rows of [annual, quarter]) {
        const ends = rows.map((r) => r.periodEnd);
        expect(ends).toEqual([...ends].sort().reverse());
      }
    }
    const { annual, quarter } = await allStatements('AAPL', statement);
    expect(annual).toHaveLength(10);
    expect(quarter).toHaveLength(8);
  });

  it('gives a recent listing fewer rows and no period from before it existed', async () => {
    const krnl = UNIVERSE.find((m) => m.symbol === 'KRNL');
    expect(krnl).toBeDefined();
    const { annual, quarter } = await allStatements('KRNL', 'income');
    expect(quarter.length).toBeGreaterThan(0);
    expect(quarter.length).toBeLessThan(8);
    expect(annual.length).toBeLessThan(10);
    const earliest = (krnl?.listedAt ?? 0) * 1000 - 366 * 86_400_000;
    for (const r of quarter) expect(Date.parse(r.periodEnd)).toBeGreaterThan(earliest);
  });

  it('lists the curated lines for every row, in order, as numbers', async () => {
    for (const statement of ['income', 'balance', 'cashflow'] as const) {
      const res = await provider.getStatements('MSFT', statement, 'quarter');
      for (const row of res.rows) {
        expect(Object.keys(row.lines)).toEqual(res.lineItems.map((l) => l.key));
        expect(Object.values(row.lines).every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
      }
    }
  });

  it('orders earnings newest first with the upcoming report first and without actuals', async () => {
    for (const m of companies) {
      const { events } = await provider.getEarnings(m.symbol);
      const dates = events.map((e) => e.date);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(events[0]).toMatchObject({ epsActual: null, revenueActual: null });
      expect(events[0]?.epsEstimate).not.toBeNull();
      expect(events.slice(1).every((e) => e.epsActual !== null && e.revenueActual !== null)).toBe(true);
      expect(events.length).toBeLessThanOrEqual(48); // 47 quarters plus the upcoming report
    }
  });

  it('holds more than 40 events for an established symbol, so "Show more" is testable offline', async () => {
    expect((await provider.getEarnings('AAPL')).events.length).toBeGreaterThan(40);
  });

  it('reports quarterly EPS in earnings equal to the quarterly income statement', async () => {
    const { events } = await provider.getEarnings('AAPL');
    const { quarter } = await allStatements('AAPL', 'income');
    expect(events[1]?.epsActual).toBe(quarter[0]?.lines.epsDiluted);
    expect(events[1]?.revenueActual).toBe(quarter[0]?.lines.revenue);
  });
});

describe('plausible for the synthetic market engine\'s price (invariants 1, 2)', () => {
  it.each(companies.map((m) => m.symbol))('%s: P/E, EPS and market cap agree with the engine\'s base price', async (symbol) => {
    const model = UNIVERSE.find((m) => m.symbol === symbol);
    const price = model?.basePrice ?? NaN;
    const o = await provider.getOverview(symbol);
    expect(o.unavailable).toEqual([]);
    const { peRatio, epsDiluted, priceToSales, grossMargin, operatingMargin, netMargin, dividendYield, payoutRatio, debtToEquity } = o.metrics;
    // P/E times EPS reproduces the price the market engine quotes (rounding of EPS to cents).
    expect((peRatio ?? NaN) * (epsDiluted ?? NaN)).toBeGreaterThan(price * 0.97);
    expect((peRatio ?? NaN) * (epsDiluted ?? NaN)).toBeLessThan(price * 1.03);
    expect(o.profile.marketCap).toBeGreaterThan(1e8);
    expect(o.profile.marketCap).toBeLessThan(2e13);
    expect(priceToSales).toBeGreaterThan(0);
    // Fractions, not percentages.
    for (const v of [grossMargin, operatingMargin, netMargin]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    expect(dividendYield).toBeGreaterThanOrEqual(0);
    expect(dividendYield).toBeLessThan(0.2);
    expect(payoutRatio).toBeGreaterThanOrEqual(0);
    expect(payoutRatio).toBeLessThan(1);
    expect(debtToEquity).toBeGreaterThanOrEqual(0);
  });

  it('makes a heavily traded symbol a bigger company than a thinly traded one', async () => {
    const big = await provider.getOverview('NVDA');
    const small = await provider.getOverview('GS');
    expect(big.profile.marketCap).toBeGreaterThan(small.profile.marketCap ?? Infinity);
  });

  it('keeps scores and analyst inside their documented ranges, with targets around the price', async () => {
    for (const m of companies) {
      const o = await provider.getOverview(m.symbol);
      expect(Number.isInteger(o.scores.piotroskiScore)).toBe(true);
      expect(o.scores.piotroskiScore).toBeGreaterThanOrEqual(0);
      expect(o.scores.piotroskiScore).toBeLessThanOrEqual(9);
      const a = o.analyst;
      expect(a.targetLow).toBeLessThan(a.targetConsensus ?? 0);
      expect(a.targetHigh).toBeGreaterThan(a.targetConsensus ?? Infinity);
      expect(a.targetConsensus).toBeGreaterThan(m.basePrice * 0.85);
      expect(a.targetConsensus).toBeLessThan(m.basePrice * 1.35);
      expect(['Strong Buy', 'Buy', 'Hold', 'Sell']).toContain(a.consensus);
    }
  });

  it('does not invent a profile: unknown sector is null, the description says it is synthetic', async () => {
    const o = await provider.getOverview('KRNL');
    expect(o.profile.sector).toBeNull();
    expect(o.profile.industry).toBeNull();
    expect(o.profile.ceo).toBeNull();
    expect(o.profile.description).toMatch(/synthetic/i);
    expect((await provider.getOverview('AAPL')).profile.sector).toBe('Technology');
  });
});
