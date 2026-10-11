/**
 * The alert check (docs/ALERTS_PLAN.md, sections 4.2–4.4). Pure: an alert and an
 * observation in, the new state and the crossings that fire out. No I/O, no clock.
 *
 * Rules:
 *  - The side is 'above' when the observed value is >= the target, else 'below'. A crossing
 *    up is below → above; a crossing down is above → below.
 *  - The first check (no `lastSide`) only records the side. It never fires.
 *  - At or after `expiresAt` the alert becomes 'expired' and does not fire.
 *  - `once` fires one time and then is 'triggered'. `every` fires on each new crossing.
 *  - Price alerts also read the day high and low. A day high that rose to the level since the
 *    last check is a crossing up even when the last price is below again (then it also
 *    crossed back down). The low is the mirror.
 *  - Indicator alerts read CLOSED bars only, each bar after `lastBarTime` in order.
 */
import type { Alert, AlertCheckState, AlertCondition, AlertStatus, Bar, IndicatorLine, Timeframe, UnixSeconds } from '@shared/types';
import { computeIndicator } from '../../src/indicators/compute';

/** One crossing that fires an event. */
export interface AlertFire {
  crossed: 'up' | 'down';
  /** The price or indicator value that crossed. */
  value: number;
  /** The level or target value at that moment. */
  target: number;
  /** The bar of the crossing (indicator alerts), else the check time. */
  time: UnixSeconds;
}

export interface AlertCheckResult {
  state: AlertCheckState;
  status: AlertStatus;
  /** In time order. Empty when nothing fired. */
  fires: AlertFire[];
}

/** The quote values a price check reads. */
export interface PriceObservation {
  price: number | null;
  dayHigh: number | null;
  dayLow: number | null;
}

/** Most events one check can make for one `every` alert (a long gap with many crossings). */
export const MAX_FIRES_PER_CHECK = 5;

/** The longest span of one bar, so the newest bar counts as closed only after it. */
export const TIMEFRAME_SPAN_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '1D': 86_400,
  '1W': 604_800,
};

type Side = 'above' | 'below';
type Direction = AlertCondition['direction'];

const sideOf = (value: number, target: number): Side => (value >= target ? 'above' : 'below');

const matches = (direction: Direction, crossed: 'up' | 'down') => direction === 'cross' || direction === crossed;

/** The status before the check: expiry wins, and only an active alert is checked. */
function precheck(alert: Alert, now: UnixSeconds): AlertCheckResult | null {
  if (alert.status !== 'active') return { state: alert.state, status: alert.status, fires: [] };
  if (now >= alert.expiresAt) return { state: { ...alert.state, lastCheckedAt: now }, status: 'expired', fires: [] };
  return null;
}

/** Keeps the fires that count: the first one for `once`, at most MAX_FIRES_PER_CHECK for `every`. */
function finish(alert: Alert, state: AlertCheckState, fires: AlertFire[], now: UnixSeconds): AlertCheckResult {
  const kept = alert.frequency === 'once' ? fires.slice(0, 1) : fires.slice(-MAX_FIRES_PER_CHECK);
  if (kept.length === 0) return { state, status: 'active', fires: [] };
  return {
    state: { ...state, firedCount: state.firedCount + kept.length, lastFiredAt: now },
    status: alert.frequency === 'once' ? 'triggered' : 'active',
    fires: kept,
  };
}

/** True when the day extremes did not only widen since the last check: a new session. */
function isNewDay(prev: AlertCheckState, high: number, low: number): boolean {
  if (prev.lastDayHigh === null || prev.lastDayLow === null) return false;
  return high < prev.lastDayHigh || low > prev.lastDayLow;
}

/** Check a price alert against one quote observation at `now`. */
export function evaluatePriceAlert(alert: Alert, obs: PriceObservation, now: UnixSeconds): AlertCheckResult {
  const early = precheck(alert, now);
  if (early) return early;
  const condition = alert.condition;
  if (condition.type !== 'price') throw new Error('evaluatePriceAlert: not a price alert');
  if (obs.price === null || !Number.isFinite(obs.price)) {
    return { state: { ...alert.state, lastCheckedAt: now }, status: 'active', fires: [] };
  }

  const level = condition.level;
  const prev = alert.state;
  const side = sideOf(obs.price, level);
  const high = obs.dayHigh !== null && Number.isFinite(obs.dayHigh) ? obs.dayHigh : null;
  const low = obs.dayLow !== null && Number.isFinite(obs.dayLow) ? obs.dayLow : null;
  const state: AlertCheckState = { ...prev, lastSide: side, lastCheckedAt: now, lastDayHigh: high, lastDayLow: low };
  if (prev.lastSide === null) return { state, status: 'active', fires: [] };

  // The crossings since the last check, in order.
  const crossings: AlertFire[] = [];
  const at = (crossed: 'up' | 'down', value: number): AlertFire => ({ crossed, value, target: level, time: now });
  const extremes = high !== null && low !== null && prev.lastDayHigh !== null && prev.lastDayLow !== null;
  const newDay = extremes && isNewDay(prev, high, low);
  if (prev.lastSide === 'below') {
    if (side === 'above') crossings.push(at('up', obs.price));
    else if (extremes && high >= level && (newDay || high > (prev.lastDayHigh as number))) {
      crossings.push(at('up', high), at('down', obs.price));
    }
  } else if (side === 'below') {
    crossings.push(at('down', obs.price));
  } else if (extremes && low < level && (newDay || low < (prev.lastDayLow as number))) {
    crossings.push(at('down', low), at('up', obs.price));
  }

  const fires = crossings.filter((c) => matches(condition.direction, c.crossed)).slice(0, 1);
  return finish(alert, state, fires, now);
}

/** The bars whose period ended at `now`. A bar followed by another bar is always closed. */
export function closedBars(bars: readonly Bar[], timeframe: Timeframe, now: UnixSeconds): Bar[] {
  const last = bars[bars.length - 1];
  if (!last) return [];
  return last.time + TIMEFRAME_SPAN_SECONDS[timeframe] <= now ? [...bars] : bars.slice(0, -1);
}

function valueAt(line: IndicatorLine | undefined, i: number): number | null {
  const v = line?.points[i]?.value;
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/**
 * Check an indicator alert. `bars` are ascending; the newest one may be forming, and is left
 * out unless its period ended at `now`. Each closed bar after `lastBarTime` is checked in order.
 */
export function evaluateIndicatorAlert(alert: Alert, bars: readonly Bar[], now: UnixSeconds): AlertCheckResult {
  const early = precheck(alert, now);
  if (early) return early;
  const condition = alert.condition;
  if (condition.type !== 'indicator') throw new Error('evaluateIndicatorAlert: not an indicator alert');

  const closed = closedBars(bars, condition.timeframe, now);
  const prev = alert.state;
  const lastBar = closed[closed.length - 1];
  if (!lastBar || (prev.lastBarTime !== null && lastBar.time <= prev.lastBarTime)) {
    return { state: { ...prev, lastCheckedAt: now }, status: 'active', fires: [] };
  }

  const series = computeIndicator(closed, condition.indicator.kind, condition.indicator.params);
  const line = series.lines.find((l) => l.key === condition.line);
  const targetLine = condition.target.type === 'line' ? series.lines.find((l) => l.key === (condition.target as { line: string }).line) : undefined;
  const targetAt = (i: number): number | null => {
    const t = condition.target;
    if (t.type === 'value') return t.value;
    if (t.type === 'close') return (closed[i] as Bar).close;
    return valueAt(targetLine, i);
  };

  // The first check looks at the newest closed bar only; later checks at each new bar.
  let start = closed.length - 1;
  if (prev.lastBarTime !== null) {
    start = closed.findIndex((b) => b.time > (prev.lastBarTime as number));
  }

  let lastSide = prev.lastSide;
  const fires: AlertFire[] = [];
  for (let i = start; i < closed.length; i++) {
    const value = valueAt(line, i);
    const target = targetAt(i);
    if (value === null || target === null) continue;
    const side = sideOf(value, target);
    if (lastSide !== null && side !== lastSide) {
      const crossed = side === 'above' ? 'up' : 'down';
      if (matches(condition.direction, crossed)) fires.push({ crossed, value, target, time: (closed[i] as Bar).time });
    }
    lastSide = side;
  }

  const state: AlertCheckState = { ...prev, lastSide, lastCheckedAt: now, lastBarTime: lastBar.time };
  return finish(alert, state, fires, now);
}

/** Check any alert. Price alerts need `price`; indicator alerts need `bars`. */
export function evaluateAlert(
  alert: Alert,
  input: { price?: PriceObservation; bars?: readonly Bar[] },
  now: UnixSeconds,
): AlertCheckResult {
  if (alert.condition.type === 'price') {
    return evaluatePriceAlert(alert, input.price ?? { price: null, dayHigh: null, dayLow: null }, now);
  }
  return evaluateIndicatorAlert(alert, input.bars ?? [], now);
}
