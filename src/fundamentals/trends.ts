import type { StatementRow, StatementsResponse } from '@shared/types';
import { fiscalLabel } from './format';

export interface TrendPoint {
  label: string;
  periodEnd: string;
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  freeCashFlow: number | null;
  /** Year-over-year growth as a fraction: against the same fiscal period one year earlier. */
  revenueGrowth: number | null;
  epsGrowth: number | null;
}

const line = (row: StatementRow | undefined, key: string): number | null => row?.lines[key] ?? null;

/** A margin of THIS period's own lines: numerator / revenue. Null when either is missing or revenue is 0. */
export function margin(numerator: number | null, revenue: number | null): number | null {
  if (numerator === null || revenue === null || revenue === 0) return null;
  return numerator / revenue;
}

/**
 * Growth from `prior` to `current` as a fraction. Null when either is missing, or when the base
 * is zero or negative: growth from a loss has no honest percentage.
 */
export function growth(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior <= 0) return null;
  return (current - prior) / prior;
}

/**
 * Per-period points, OLDEST first (charts read left to right). Margins come from the same
 * period's income lines, never from the TTM ratios. Cash-flow rows are matched to income rows
 * by fiscal year and period, not by position. Growth is year over year, so a quarter compares
 * with the same quarter of the year before (no seasonality), and a missing period gives null.
 */
export function buildTrend(income: StatementsResponse, cashflow: StatementsResponse): TrendPoint[] {
  const key = (r: { fiscalYear: number; fiscalPeriod: string }) => `${r.fiscalYear}-${r.fiscalPeriod}`;
  const cash = new Map(cashflow.rows.map((r) => [key(r), r]));
  const byPeriod = new Map(income.rows.map((r) => [key(r), r]));
  return [...income.rows].reverse().map((r) => {
    const revenue = line(r, 'revenue');
    const prior = byPeriod.get(key({ fiscalYear: r.fiscalYear - 1, fiscalPeriod: r.fiscalPeriod }));
    return {
      label: fiscalLabel(r),
      periodEnd: r.periodEnd,
      revenue,
      netIncome: line(r, 'netIncome'),
      eps: line(r, 'epsDiluted'),
      grossMargin: margin(line(r, 'grossProfit'), revenue),
      operatingMargin: margin(line(r, 'operatingIncome'), revenue),
      netMargin: margin(line(r, 'netIncome'), revenue),
      freeCashFlow: line(cash.get(key(r)), 'freeCashFlow'),
      revenueGrowth: growth(revenue, line(prior, 'revenue')),
      epsGrowth: growth(line(r, 'epsDiluted'), line(prior, 'epsDiluted')),
    };
  });
}
