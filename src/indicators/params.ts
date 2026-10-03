import type { IndicatorKind, IndicatorParams, MacdParams, MovingAverageParams, RsiParams } from '@shared/types';
import { InvalidIndicatorParamsError, LINE_KEYS, PERIOD_MAX, PERIOD_MIN } from './types';

const SOURCES: readonly string[] = ['open', 'high', 'low', 'close'];

function periodError(name: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${name} must be an integer between ${PERIOD_MIN} and ${PERIOD_MAX}`;
  }
  if (value < PERIOD_MIN || value > PERIOD_MAX) {
    return `${name} must be between ${PERIOD_MIN} and ${PERIOD_MAX}, got ${value}`;
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
  if (kind !== 'rsi' && p.source !== undefined && !SOURCES.includes(p.source)) {
    return `source must be one of ${SOURCES.join(', ')}`;
  }
  return null;
}

export function assertValidParams(kind: IndicatorKind, params: IndicatorParams): void {
  const message = checkIndicatorParams(kind, params);
  if (message !== null) throw new InvalidIndicatorParamsError(message);
}
