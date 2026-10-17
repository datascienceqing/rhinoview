import { describe, expect, it } from 'vitest';
import type { StatementRow, StatementsResponse } from '@shared/types';
import { buildTrend, growth, margin } from './trends';

const row = (fiscalYear: number, lines: Record<string, number | null>): StatementRow => ({
  fiscalYear,
  fiscalPeriod: 'FY',
  periodEnd: `${fiscalYear}-12-31`,
  filingDate: null,
  reportedCurrency: 'USD',
  lines,
});
const resp = (statement: 'income' | 'cashflow', rows: StatementRow[]): StatementsResponse => ({
  symbol: 'X',
  statement,
  period: 'annual',
  lineItems: [],
  rows,
});

describe('buildTrend', () => {
  it('computes margins from each period own lines, oldest first', () => {
    const income = resp('income', [
      row(2025, { revenue: 200, grossProfit: 100, operatingIncome: 50, netIncome: 40, epsDiluted: 2 }),
      row(2024, { revenue: 100, grossProfit: 20, operatingIncome: 10, netIncome: -5, epsDiluted: -1 }),
    ]);
    const cash = resp('cashflow', [row(2025, { freeCashFlow: 30 }), row(2024, { freeCashFlow: -3 })]);
    const pts = buildTrend(income, cash);
    expect(pts.map((p) => p.label)).toEqual(['FY2024', 'FY2025']);
    expect(pts[0]).toMatchObject({ grossMargin: 0.2, operatingMargin: 0.1, netMargin: -0.05, freeCashFlow: -3 });
    expect(pts[1]).toMatchObject({ grossMargin: 0.5, netMargin: 0.2, freeCashFlow: 30 });
  });

  it('gives null, not zero, when a line is missing or revenue is zero', () => {
    expect(margin(null, 100)).toBeNull();
    expect(margin(5, 0)).toBeNull();
    const pts = buildTrend(resp('income', [row(2025, { revenue: 100 })]), resp('cashflow', []));
    expect(pts[0]).toMatchObject({ grossMargin: null, freeCashFlow: null, netIncome: null });
  });

  it('computes year-over-year growth against the same fiscal period, null for the oldest', () => {
    const income = resp('income', [
      row(2025, { revenue: 150, epsDiluted: 3 }),
      row(2024, { revenue: 100, epsDiluted: 2 }),
    ]);
    const pts = buildTrend(income, resp('cashflow', []));
    expect(pts[0]).toMatchObject({ revenueGrowth: null, epsGrowth: null });
    expect(pts[1]).toMatchObject({ revenueGrowth: 0.5, epsGrowth: 0.5 });
  });

  it('compares a quarter with the same quarter one year earlier, not the previous quarter', () => {
    const q = (fiscalYear: number, fiscalPeriod: StatementRow['fiscalPeriod'], revenue: number): StatementRow => ({
      ...row(fiscalYear, { revenue }),
      fiscalPeriod,
    });
    const income = resp('income', [q(2025, 'Q2', 120), q(2025, 'Q1', 999), q(2024, 'Q4', 999), q(2024, 'Q3', 999), q(2024, 'Q2', 100)]);
    const pts = buildTrend(income, resp('cashflow', []));
    expect(pts.at(-1)?.revenueGrowth).toBeCloseTo(0.2);
    expect(pts.at(-2)?.revenueGrowth).toBeNull();
  });
});

describe('growth', () => {
  it('gives null when the base is missing, zero or negative', () => {
    expect(growth(10, null)).toBeNull();
    expect(growth(10, 0)).toBeNull();
    expect(growth(10, -5)).toBeNull();
    expect(growth(-5, 10)).toBe(-1.5);
  });
});
