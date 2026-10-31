import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Alert } from '@shared/types';
import { MAX_ALERT_MESSAGE_LENGTH } from '@shared/types';
import { openAlertsStore } from '../alerts/store';
import { openAnalysesStore } from './analyses';
import { buildAiAlerts, expiryBefore, REASONS } from './alerts';
import type { Facts } from './facts/build';
import type { Plan } from './facts/plans';

// Fri 2026-10-30, 21:00 UTC.
const NOW = Date.UTC(2026, 9, 30, 21) / 1000;

function plan(over: Partial<Plan>): Plan {
  return {
    kind: 'retest', side: 'short', entryType: 'limit', entryLow: 324.15, entryHigh: 326.37, rrEntry: 324.15, trigger: 't',
    invalidation: { price: 326.37, label: 'broken support' }, stop: 333.73, stopPct: 2.95,
    stopRule: { invalidation: 326.37, atrMult: 0.5, atrLower: 14.71 },
    targets: [{ price: 273.07, label: 'OB', pct: -15.76, rr: 5.34 }, { price: 238, label: 'OB', pct: -26.6, rr: 9 }],
    sizePct: 1, sizeReason: null, meetsTwoToOne: true, ...over,
  };
}

/** The parts of the facts that the alert builder reads (TER on 2026-10-30). */
function facts(plans: Plan[], next: string | null = '2027-01-27'): Facts {
  return {
    symbol: 'TER', quote: { last: 274.37, change: null, changePct: null },
    timeframes: { '1D': { atr: 22.19, lastBar: { close: 274.37 } } }, earnings: { next, sessionsAway: null }, plans,
  } as unknown as Facts;
}

const priceAlert = (level: number): Alert =>
  ({ id: 'x', symbol: 'TER', condition: { type: 'price', direction: 'cross', level }, status: 'active' }) as Alert;

describe('buildAiAlerts', () => {
  it('makes the entry and invalidation of a short retest, and rejects T1 that comes before the entry', () => {
    const { candidates, rejected } = buildAiAlerts(facts([plan({})]), [], NOW, 'an1');
    expect(candidates.map((c) => [c.origin.role, c.level, c.body.condition])).toEqual([
      ['entry', 324.15, { type: 'price', direction: 'up', level: 324.15 }],
      ['invalidation', 326.37, { type: 'price', direction: 'up', level: 326.37 }],
    ]);
    expect(rejected).toEqual([{ plan: 'short retest', role: 'target', level: 273.07, reason: REASONS.order }]);
    expect(candidates[0]?.origin).toEqual({ kind: 'ai', analysisId: 'an1', plan: 'short retest', role: 'entry' });
    expect(candidates[0]?.body.message).toContain('Stop 333.73, T1 273.07');
  });

  it('keeps T1 of a continuation, because price passes the entry first', () => {
    const cont = plan({ kind: 'continuation', entryType: 'stop', entryLow: 270.85, entryHigh: 270.85, invalidation: { price: 273.07, label: 'x' }, targets: [{ price: 238, label: 'OB', pct: -12, rr: 3.4 }] });
    const { candidates } = buildAiAlerts(facts([cont]), [], NOW, 'an1');
    expect(candidates.map((c) => [c.origin.role, c.body.condition])).toEqual([
      ['entry', { type: 'price', direction: 'down', level: 270.85 }],
      ['target', { type: 'price', direction: 'down', level: 238 }],
    ]);
  });

  it('rejects a level that price already passed, a far level, and a duplicate', () => {
    const market = plan({ kind: 'market', entryType: 'market', entryLow: 274.37, entryHigh: 274.37, invalidation: { price: 270, label: 'x' }, targets: [{ price: 150, label: 'far', pct: -45, rr: 9 }] });
    const r1 = buildAiAlerts(facts([market]), [], NOW, 'a');
    expect(r1.rejected.map((x) => x.reason)).toEqual([REASONS.crossed, REASONS.far]);
    const r2 = buildAiAlerts(facts([plan({})]), [priceAlert(325)], NOW, 'a');
    expect(r2.rejected.filter((x) => x.reason === REASONS.duplicate).map((x) => x.role)).toEqual(['entry', 'invalidation']);
  });

  it('picks an expiry that ends before the earnings day', () => {
    expect(expiryBefore(NOW, '2027-01-27').expiry).toBe('1M');
    expect(expiryBefore(NOW, '2026-11-18')).toEqual({ expiry: '2w', crossesEarnings: false });
    expect(expiryBefore(NOW, '2026-11-02')).toEqual({ expiry: '1w', crossesEarnings: true });
    const { candidates } = buildAiAlerts(facts([plan({})], '2026-11-02'), [], NOW, 'a');
    expect(candidates[0]?.body.message).toContain('Earnings on 2026-11-02.');
    for (const c of candidates) expect(c.body.message?.length ?? 0).toBeLessThanOrEqual(MAX_ALERT_MESSAGE_LENGTH);
  });
});

describe('alert origin in the store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rhinoview-ai-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the origin after a reload, and copies it into the fired event', async () => {
    const file = join(dir, 'alerts.json');
    let t = NOW;
    const store = await openAlertsStore(file, { now: () => t, warn: () => undefined });
    const origin = { kind: 'ai' as const, analysisId: 'an1', plan: 'short retest', role: 'entry' as const };
    const a = await store.create({ symbol: 'TER', condition: { type: 'price', direction: 'up', level: 324.15 } }, origin);
    expect(a.origin).toEqual(origin);
    const again = await openAlertsStore(file, { now: () => t, warn: () => undefined });
    expect(again.list()[0]?.origin).toEqual(origin);

    t += 60;
    const [event] = await again.applyChecks([
      { alertId: a.id, revision: a.revision, delayed: false, result: { fires: [{ crossed: 'up', value: 325, target: 324.15, time: t }], state: { ...a.state, lastSide: 'above', lastCheckedAt: t }, status: 'triggered' } },
    ]);
    expect(event?.origin).toEqual(origin);
  });

  it('saves analyses newest first, and finds them by id', async () => {
    const store = await openAnalysesStore(join(dir, 'ai', 'analyses.json'));
    await store.save({ id: 'a1', symbol: 'TER', createdAt: NOW, question: 'q', facts: { x: 1 }, text: null, alertIds: ['al1'] });
    await store.save({ id: 'a2', symbol: 'CAT', createdAt: NOW, question: 'q', facts: {}, text: null, alertIds: [] });
    const reopened = await openAnalysesStore(join(dir, 'ai', 'analyses.json'));
    expect(reopened.get('a1')?.alertIds).toEqual(['al1']);
    expect(reopened.get('missing')).toBeNull();
  });
});
