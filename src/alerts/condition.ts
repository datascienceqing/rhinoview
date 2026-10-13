/**
 * Checks of an alert condition and message (docs/ALERTS_PLAN.md, sections 4.2 and 4.3).
 *
 * Pure and non-throwing, like `checkIndicatorParams`: the dialog shows the message while
 * the user types, and the server (store and mock) rejects the same input with it.
 */
import { ALERT_INDICATOR_KINDS, MAX_ALERT_MESSAGE_LENGTH } from '@shared/types';
import type { AlertCondition, AlertDirection, AlertIndicatorKind, ConfluenceParams } from '@shared/types';
import { checkIndicatorParams } from '../indicators/params';
import { LINE_KEYS } from '../indicators/types';

const DIRECTIONS: readonly AlertDirection[] = ['cross', 'up', 'down'];

/**
 * Indicators whose values are prices, so the close is a fair target. RSI (0-100) and MACD
 * (a difference of two EMAs, near 0) are on other scales: a close target would never cross.
 */
export const CLOSE_TARGET_KINDS: readonly AlertIndicatorKind[] = ['sma', 'ema'];

/** A confluence alert fires up in mode 'turn' (a breakout) and down in mode 'breakdown'. */
export const confluenceDirection = (params: Pick<ConfluenceParams, 'mode'>): 'up' | 'down' => (params.mode === 'turn' ? 'up' : 'down');

/** The direction of any condition: a confluence alert takes it from its mode. */
export const directionOf = (condition: AlertCondition): AlertDirection =>
  condition.type === 'confluence' ? confluenceDirection(condition.params) : condition.direction;

/** Same symbol format as the workspace (watchlists, layouts). */
export const ALERT_SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,16}$/;

/**
 * The reason `condition` is not acceptable, or `null` when it is.
 * `stored`: an alert read from the file. It skips the rules added after alerts were saved
 * (the close target rule), so a reload never drops an alert that was valid when it was made.
 */
export function checkAlertCondition(condition: AlertCondition, opts: { stored?: boolean } = {}): string | null {
  if (condition.type === 'confluence') return checkConfluenceCondition(condition);
  if (!DIRECTIONS.includes(condition.direction)) return `direction must be one of ${DIRECTIONS.join(', ')}`;
  if (condition.type === 'price') {
    if (!Number.isFinite(condition.level) || condition.level <= 0) return 'level must be a positive number';
    return null;
  }
  const { kind, params } = condition.indicator;
  if (!(ALERT_INDICATOR_KINDS as readonly string[]).includes(kind)) {
    return `indicator must be one of ${ALERT_INDICATOR_KINDS.join(', ')}`;
  }
  const paramsError = checkIndicatorParams(kind, params);
  if (paramsError !== null) return paramsError;
  const lines = LINE_KEYS[kind];
  if (!lines.includes(condition.line)) return `line must be one of ${lines.join(', ')}`;
  const target = condition.target;
  if (target.type === 'close' && !opts.stored && !CLOSE_TARGET_KINDS.includes(kind)) {
    return 'target close is only for SMA and EMA: other indicators are not on the price scale';
  }
  if (target.type === 'value') {
    if (!Number.isFinite(target.value)) return 'target value must be a finite number';
  } else if (target.type === 'line') {
    if (!lines.includes(target.line)) return `target line must be one of ${lines.join(', ')}`;
    if (target.line === condition.line) return 'target line must differ from the line';
  }
  return null;
}

function checkConfluenceCondition(condition: Extract<AlertCondition, { type: 'confluence' }>): string | null {
  const { params, lock } = condition;
  const paramsError = checkIndicatorParams('confluence', params);
  if (paramsError !== null) return paramsError;
  // Without a latch the trigger moves with the price on each bar: there is no level to keep.
  if (params.latch !== 'on' || params.latchTime <= 0) return 'a confluence alert needs the latch on, with a latch date';
  if (typeof lock !== 'object' || lock === null) return 'lock must be an object';
  if (![lock.bottom, lock.top].every((v) => Number.isFinite(v) && v > 0)) return 'lock bottom and top must be positive numbers';
  if (lock.bottom > lock.top) return 'lock bottom must be at most lock top';
  if (!Number.isInteger(lock.count) || lock.count < 1) return 'lock count must be a positive integer';
  if (!Number.isInteger(lock.time) || lock.time < params.latchTime) return 'lock time must be a bar time at or after the latch date';
  return null;
}

/** The reason `message` is not acceptable, or `null`. */
export function checkAlertMessage(message: string): string | null {
  if (message.length > MAX_ALERT_MESSAGE_LENGTH) return `message must be at most ${MAX_ALERT_MESSAGE_LENGTH} characters`;
  return null;
}
