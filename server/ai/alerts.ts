/**
 * AI alerts (docs/AI_HELPER_PLAN.md, step D): price alerts made from the featured plans of
 * the facts, the same plans that the chart draws. Pure: the route saves the valid ones.
 *
 * For each plan:
 * - entry (not for an at-market plan): the first price of the entry zone, in the direction
 *   that price must move to reach it;
 * - invalidation (not for a continuation plan, whose trigger level is also its invalidation):
 *   the level, against the trade;
 * - T1: in the trade direction, only when price must pass the entry before T1. Otherwise T1
 *   would fire before the trade exists.
 */
import { ALERT_EXPIRY_CHOICES, MAX_ALERT_MESSAGE_LENGTH } from '@shared/types';
import type { Alert, AlertDirection, AlertExpiry, AlertOrigin, CreateAlertBody } from '@shared/types';
import { computeExpiresAt } from '../../src/alerts/expiry';
import { featuredPlan } from './facts/build';
import type { Facts } from './facts/build';

export interface AlertCandidate {
  body: CreateAlertBody;
  origin: AlertOrigin;
  level: number;
}

export interface Rejected {
  plan: string;
  role: AlertOrigin['role'];
  level: number;
  reason: string;
}

/** A level further than this many daily ATRs from the price makes no alert. */
export const MAX_ALERT_ATR = 3;
/** An existing alert this near (in daily ATRs) is the same alert. */
export const DUPLICATE_ATR = 0.1;

export const REASONS = {
  crossed: 'The price is already past this level.',
  far: `The level is more than ${MAX_ALERT_ATR} × ATR(1D) from the price.`,
  ratio: 'The plan does not reach 2:1.',
  duplicate: 'An alert at this level already exists.',
  order: 'The price reaches this target before the entry. Add it after the entry fires.',
} as const;

const ARROW = { long: '▲', short: '▼' } as const;

/** The longest expiry that ends before the earnings day; 1M when the date is unknown. */
export function expiryBefore(now: number, earningsDay: string | null): { expiry: AlertExpiry; crossesEarnings: boolean } {
  if (!earningsDay) return { expiry: '1M', crossesEarnings: false };
  const earnings = Date.parse(`${earningsDay}T00:00:00Z`) / 1000;
  const order: AlertExpiry[] = ['1M', '3w', '2w', '1w'];
  const fit = order.find((e) => ALERT_EXPIRY_CHOICES.includes(e) && computeExpiresAt(now, e) < earnings);
  return fit ? { expiry: fit, crossesEarnings: false } : { expiry: '1w', crossesEarnings: true };
}

const clip = (s: string) => (s.length <= MAX_ALERT_MESSAGE_LENGTH ? s : `${s.slice(0, MAX_ALERT_MESSAGE_LENGTH - 1)}…`);

export function buildAiAlerts(facts: Facts, existing: readonly Alert[], now: number, analysisId: string): { candidates: AlertCandidate[]; rejected: Rejected[] } {
  const price = facts.quote?.last ?? facts.timeframes['1D']?.lastBar.close ?? null;
  const atr = facts.timeframes['1D']?.atr ?? null;
  const candidates: AlertCandidate[] = [];
  const rejected: Rejected[] = [];
  if (price === null || atr === null) return { candidates, rejected };

  const { expiry, crossesEarnings } = expiryBefore(now, facts.earnings.next);
  const earningsNote = crossesEarnings && facts.earnings.next ? ` Earnings on ${facts.earnings.next}.` : '';
  const others = existing.filter((a) => a.symbol === facts.symbol && a.condition.type === 'price' && (a.status === 'active' || a.status === 'paused'));

  const plans = (['long', 'short'] as const).flatMap((side) => {
    const p = featuredPlan(facts.plans.filter((x) => x.side === side));
    return p ? [p] : [];
  });

  for (const p of plans) {
    const name = `${p.side} ${p.kind}`;
    const tag = `AI ${ARROW[p.side]} ${name}`;
    const sign = p.side === 'long' ? 1 : -1;
    const toward = (level: number): AlertDirection => (level > price ? 'up' : 'down');
    const t1 = p.targets[0];
    const entry = p.kind === 'market' ? null : p.entryType === 'limit' ? (p.side === 'short' ? p.entryLow : p.entryHigh) : p.entryLow;
    const stopText = `Stop ${p.stop}${t1 ? `, T1 ${t1.price}` : ''}.`;

    const levels: { role: AlertOrigin['role']; level: number; direction: AlertDirection; message: string }[] = [];
    if (entry !== null) {
      const how = p.entryType === 'limit' ? `${p.side === 'short' ? 'Sell' : 'Buy'} limit after a 4H rejection.` : `${p.side === 'short' ? 'Sell' : 'Buy'} stop after a daily close past ${p.invalidation.price}.`;
      levels.push({ role: 'entry', level: entry, direction: toward(entry), message: `${tag}: entry ${entry}. ${how} ${stopText}` });
    }
    if (p.kind !== 'continuation') {
      const inv = p.invalidation.price;
      levels.push({ role: 'invalidation', level: inv, direction: sign > 0 ? 'down' : 'up', message: `${tag}: invalidation ${inv}. A daily close past it ends the plan.` });
    }
    if (t1) {
      levels.push({ role: 'target', level: t1.price, direction: sign > 0 ? 'up' : 'down', message: `${tag}: T1 ${t1.price}. If you are in the trade: take half off, move the stop to the entry.` });
    }

    for (const l of levels) {
      const reject = (reason: string) => rejected.push({ plan: name, role: l.role, level: l.level, reason });
      const passed = l.direction === 'up' ? l.level <= price : l.level >= price;
      if (passed) {
        reject(REASONS.crossed);
        continue;
      }
      if (Math.abs(l.level - price) > MAX_ALERT_ATR * atr) {
        reject(REASONS.far);
        continue;
      }
      if (l.role === 'entry' && !p.meetsTwoToOne) {
        reject(REASONS.ratio);
        continue;
      }
      // T1 of a pending plan: the entry must be between the price and T1.
      if (l.role === 'target' && entry !== null && !(Math.min(price, l.level) < entry && entry < Math.max(price, l.level))) {
        reject(REASONS.order);
        continue;
      }
      const near = (level: number) => Math.abs(level - l.level) <= DUPLICATE_ATR * atr;
      if (others.some((a) => a.condition.type === 'price' && near(a.condition.level)) || candidates.some((c) => near(c.level))) {
        reject(REASONS.duplicate);
        continue;
      }
      candidates.push({
        level: l.level,
        origin: { kind: 'ai', analysisId, plan: name, role: l.role },
        body: { symbol: facts.symbol, condition: { type: 'price', direction: l.direction, level: l.level }, frequency: 'once', expiry, message: clip(`${l.message}${earningsNote}`) },
      });
    }
  }
  return { candidates, rejected };
}
