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
}

const line = (row: StatementRow | undefined, key: string): number | null => row?.lines[key] ?? null;

/** A margin of THIS period's own lines: numerator / revenue. Null when either is missing or revenue is 0. */
export function margin(numerator: number | null, revenue: number | null): number | null {
  if (numerator === null || revenue === null || revenue === 0) return null;
  return numerator / revenue;
}

/**
 * Per-period points, OLDEST first (charts read left to right). Margins come from the same
 * period's income lines, never from the TTM ratios. Cash-flow rows are matched to income rows
 * by fiscal year and period, not by position.
 */
export function buildTrend(income: StatementsResponse, cashflow: StatementsResponse): TrendPoint[] {
  const cash = new Map(cashflow.rows.map((r) => [`${r.fiscalYear}-${r.fiscalPeriod}`, r]));
  return [...income.rows].reverse().map((r) => {
    const revenue = line(r, 'revenue');
    return {
      label: fiscalLabel(r),
      periodEnd: r.periodEnd,
      revenue,
      netIncome: line(r, 'netIncome'),
      eps: line(r, 'epsDiluted'),
      grossMargin: margin(line(r, 'grossProfit'), revenue),
      operatingMargin: margin(line(r, 'operatingIncome'), revenue),
      netMargin: margin(line(r, 'netIncome'), revenue),
      freeCashFlow: line(cash.get(`${r.fiscalYear}-${r.fiscalPeriod}`), 'freeCashFlow'),
    };
  });
}
