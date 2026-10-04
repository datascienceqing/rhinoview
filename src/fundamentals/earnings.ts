import type { EarningsEvent } from '@shared/types';
import { useAsync } from '../data';
import { fetchEarnings } from './api';

export type EarningsOutcome = 'beat' | 'miss' | 'inline' | 'upcoming' | 'unknown';

/** A report is past once the provider has published any actual. Upcoming ones have none. */
export function isPast(e: EarningsEvent): boolean {
  return e.epsActual !== null || e.revenueActual !== null;
}

function compare(actual: number | null, estimate: number | null): 'beat' | 'miss' | 'inline' | null {
  if (actual === null || estimate === null) return null;
  if (actual > estimate) return 'beat';
  if (actual < estimate) return 'miss';
  return 'inline';
}

/** Beat or miss is decided by EPS, the headline number; revenue decides only when EPS cannot. */
export function outcomeOf(e: EarningsEvent): EarningsOutcome {
  if (!isPast(e)) return 'upcoming';
  return compare(e.epsActual, e.epsEstimate) ?? compare(e.revenueActual, e.revenueEstimate) ?? 'unknown';
}

/** Surprise in percent: (actual - estimate) / |estimate| * 100. Null without a usable estimate. */
export function surprisePercent(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return ((actual - estimate) / Math.abs(estimate)) * 100;
}

/** One shared request per symbol: the Earnings tab and the chart markers both use this. */
export function useEarnings(symbol: string | null) {
  return useAsync(symbol === null ? null : `earnings:${symbol}`, () => fetchEarnings(symbol as string));
}
