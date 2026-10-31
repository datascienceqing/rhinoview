/**
 * The confluence table of the trade-check skill: rows, arrows, the count, and the
 * conviction. The server counts, so the model cannot miscount (samples 003 and 005 did).
 */
import type { Direction } from './plans';

export type Arrow = 'up' | 'down' | 'neutral';

export interface ConfluenceRow {
  id: string;
  signal: string;
  reading: string;
  arrow: Arrow;
}

export type Conviction = 'high' | 'moderate' | 'none';

export interface ConfluenceResult {
  rows: ConfluenceRow[];
  bullish: number;
  bearish: number;
  neutral: number;
  /** For `direction`, or for the side with more rows when the question has no direction. */
  side: Direction;
  /** The rows with `side`, as a % of all rows. */
  withPct: number;
  conviction: Conviction;
  /** The exhaustion row points against `side`. */
  cappedByExhaustion: boolean;
}

/** 85% or more: high; 65–84%: moderate; under 65%: no bias. Exhaustion against the side caps it at moderate. */
export function scoreConfluence(rows: readonly ConfluenceRow[], direction: Direction | null): ConfluenceResult {
  const bullish = rows.filter((r) => r.arrow === 'up').length;
  const bearish = rows.filter((r) => r.arrow === 'down').length;
  const neutral = rows.length - bullish - bearish;
  const side: Direction = direction ?? (bearish > bullish ? 'short' : 'long');
  const withCount = side === 'long' ? bullish : bearish;
  const withPct = rows.length ? (withCount / rows.length) * 100 : 0;
  const against: Arrow = side === 'long' ? 'down' : 'up';
  const cappedByExhaustion = rows.some((r) => r.id === 'exhaustion' && r.arrow === against);
  let conviction: Conviction = withPct >= 85 ? 'high' : withPct >= 65 ? 'moderate' : 'none';
  if (cappedByExhaustion && conviction === 'high') conviction = 'moderate';
  return { rows: [...rows], bullish, bearish, neutral, side, withPct, conviction, cappedByExhaustion };
}
