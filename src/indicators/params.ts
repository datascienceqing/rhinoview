import type { IndicatorKind, IndicatorParams, LiquidityParams, MacdParams, MovingAverageParams, RsiParams, VpvrParams } from '@shared/types';
import {
  InvalidIndicatorParamsError,
  LINE_KEYS,
  LIQUIDITY_BOUNDS,
  LIQUIDITY_SWEEP_MODES,
  LIQUIDITY_ZONE_MODES,
  PERIOD_MAX,
  PERIOD_MIN,
  VPVR_BOUNDS,
} from './types';
import type { LiquidityNumericKey } from './types';

const SOURCES: readonly string[] = ['open', 'high', 'low', 'close'];

function periodError(name: string, value: unknown, min = PERIOD_MIN, max = PERIOD_MAX): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${name} must be an integer between ${min} and ${max}`;
  }
  if (value < min || value > max) {
    return `${name} must be between ${min} and ${max}, got ${value}`;
  }
  return null;
}

/**
 * The reason `params` are not acceptable for `kind`, or `null` when they are.
 *
 * Non-throwing so the parameter editor can show the message while the user is still
 * typing; `computeIndicator` turns the same message into an `InvalidIndicatorParamsError`.
 * Bounds match the server's `/api/indicator` validation.
 */
export function checkIndicatorParams(kind: IndicatorKind, params: IndicatorParams): string | null {
  if (!Object.hasOwn(LINE_KEYS, kind)) return `unknown indicator kind: ${String(kind)}`;
  if (typeof params !== 'object' || params === null) return 'params must be an object';
  if (kind === 'vpvr') {
    const p = params as Partial<VpvrParams>;
    for (const key of Object.keys(VPVR_BOUNDS) as (keyof VpvrParams)[]) {
      const { min, max } = VPVR_BOUNDS[key];
      const err = periodError(key, p[key], min, max);
      if (err) return err;
    }
    return null;
  }
  if (kind === 'liquidity') {
    const p = params as Partial<LiquidityParams>;
    for (const key of Object.keys(LIQUIDITY_BOUNDS) as LiquidityNumericKey[]) {
      const { min, max } = LIQUIDITY_BOUNDS[key];
      const err = periodError(key, p[key], min, max);
      if (err) return err;
    }
    if (!LIQUIDITY_ZONE_MODES.some((m) => m === p.zoneMode)) return `zoneMode must be one of ${LIQUIDITY_ZONE_MODES.join(', ')}`;
    if (!LIQUIDITY_SWEEP_MODES.some((m) => m === p.sweepMode)) return `sweepMode must be one of ${LIQUIDITY_SWEEP_MODES.join(', ')}`;
    return null;
  }
  if (kind === 'macd') {
    const p = params as Partial<MacdParams>;
    const err =
      periodError('fastPeriod', p.fastPeriod) ??
      periodError('slowPeriod', p.slowPeriod) ??
      periodError('signalPeriod', p.signalPeriod);
    if (err) return err;
    if ((p.fastPeriod as number) >= (p.slowPeriod as number)) {
      return `fastPeriod (${String(p.fastPeriod)}) must be less than slowPeriod (${String(p.slowPeriod)})`;
    }
    return null;
  }
  const p = params as Partial<MovingAverageParams & RsiParams>;
  const err = periodError('period', p.period);
  if (err) return err;
  if ((kind === 'sma' || kind === 'ema') && p.source !== undefined && !SOURCES.includes(p.source)) {
    return `source must be one of ${SOURCES.join(', ')}`;
  }
  return null;
}

export function assertValidParams(kind: IndicatorKind, params: IndicatorParams): void {
  const message = checkIndicatorParams(kind, params);
  if (message !== null) throw new InvalidIndicatorParamsError(message);
}
