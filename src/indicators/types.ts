/**
 * INDICATOR SEAM — the interface between the computation module and the pane UI.
 *
 * ORCHESTRATOR-OWNED. Frozen. Two workers are building against this file in parallel:
 * one implements the math in `src/indicators/`, the other consumes it from
 * `src/panes/`. An unilateral edit here breaks the other silently. If something is
 * wrong or missing, stop and report it.
 *
 * The data types themselves — `IndicatorSeries`, `IndicatorLine`, `IndicatorPoint`,
 * `IndicatorConfig`, `INDICATOR_PLACEMENT` — already live in `shared/types.ts` and are
 * frozen too. This file adds only the calling convention and the parameter rules.
 */
import type {
  Bar,
  IndicatorKind,
  IndicatorParams,
  IndicatorSeries,
  MacdParams,
  MovingAverageParams,
  RsiParams,
} from '@shared/types';

/**
 * The single entry point the pane UI calls. Pure: same bars and params in, same
 * series out, no clock, no randomness, no DOM, no network.
 *
 * `bars` must be ascending by time, strictly increasing — the proxy guarantees it.
 * The returned series has exactly one point per input bar, at the same `time`, in the
 * same order, so a renderer can zip it against the price series without searching.
 */
export type ComputeIndicator = (
  bars: readonly Bar[],
  kind: IndicatorKind,
  params: IndicatorParams,
) => IndicatorSeries;

/** Defaults the UI offers when a user adds an indicator without choosing parameters. */
export const DEFAULT_PARAMS: {
  sma: MovingAverageParams;
  ema: MovingAverageParams;
  rsi: RsiParams;
  macd: MacdParams;
} = {
  sma: { period: 20, source: 'close' },
  ema: { period: 20, source: 'close' },
  rsi: { period: 14 },
  macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
};

/**
 * Bounds the parameter editor enforces and the math module validates.
 * These match the server's `/api/indicator` bounds, so the two implementations
 * accept exactly the same inputs and a differential test cannot drift on validation.
 */
export const PERIOD_MIN = 1;
export const PERIOD_MAX = 500;

/** Line keys, fixed so the pane can style and label them without guessing. */
export const LINE_KEYS: Record<IndicatorKind, readonly string[]> = {
  sma: ['value'],
  ema: ['value'],
  rsi: ['value'],
  macd: ['macd', 'signal', 'histogram'],
};

/** Thrown for parameters outside the bounds above, or a MACD with `fast >= slow`. */
export class InvalidIndicatorParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIndicatorParamsError';
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// CONVENTIONS THE MATH MUST FOLLOW
//
// These are not stylistic. Each is a place where two defensible choices give
// visibly different lines, and where the server's implementation has already
// committed to one of them. Diverging means the differential test fails and, worse,
// that the chart and the oracle endpoint disagree about the same symbol.
//
// 1. WARMUP IS `null`, NEVER `0`. A zero draws a real line at zero and misleads the
//    reader. `IndicatorSeries.warmup` is the count of LEADING bars for which NO line
//    has a value. Note the asymmetry this creates for MACD: warmup is `slowPeriod-1`,
//    but the signal and histogram lines stay null for longer than that, so only the
//    one-directional assertion in `shared/types.ts` holds — `value === null` for every
//    index below `warmup`, not the converse.
//
// 2. EMA IS SEEDED WITH THE SMA of the first `period` values. The alternatives
//    (seed with the first close, or start from zero) produce a visibly different curve
//    for dozens of bars. Multiplier is `2 / (period + 1)`.
//
// 3. RSI USES WILDER SMOOTHING, not a simple moving average of gains and losses.
//    This is the single most commonly got-wrong indicator in existence; a simple-mean
//    RSI is a different and more jagged line that happens to look plausible. The first
//    value sits at index `period`, seeded with the simple mean of the first `period`
//    gains and losses, and every subsequent value uses
//    `avg = (prevAvg * (period - 1) + current) / period`.
//    Edge cases that must be right: a flat series gives 50, a monotonically rising
//    series gives 100, and an all-losses window must not divide by zero.
//
// 4. MACD IS EMA(fast) - EMA(slow), with the signal line an EMA of the MACD line and
//    the histogram `macd - signal`. The signal's EMA seeds from the SMA of the first
//    `signalPeriod` DEFINED MACD values — it must skip the nulls rather than treat
//    them as zeros, which is the usual off-by-`slowPeriod` bug.
//
// 5. OUTPUT LENGTH EQUALS INPUT LENGTH. One point per bar, same times, same order,
//    including the warmup nulls. Do not return a shorter array starting at the first
//    defined value; the renderer zips against the price series by index.
//
// 6. `source` ON SMA/EMA defaults to 'close' when absent.
// ───────────────────────────────────────────────────────────────────────────────
