import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@shared/types';
import { randomBars } from '../../../src/indicators/fixtures';
import { buildFacts, featuredPlan, MAX_ZONE_MARKS, sessionsBetween } from './build';
import type { FactsInput } from './build';

// Fri 2026-10-16 12:00 New York, during the session.
const ASKED = Date.UTC(2026, 9, 16, 16) / 1000;
const DAY = 86_400;

function input(over: Partial<FactsInput> = {}): FactsInput {
  // 400 daily bars ending on the question day, so the data is not stale.
  const daily = randomBars(400, 7, ASKED - 399 * DAY - 4 * 3600, DAY);
  const last = daily[daily.length - 1];
  const quote: Snapshot = {
    symbol: 'TEST', price: last?.close ?? null, change: 1, changePercent: 0.01, previousClose: null, dayOpen: null,
    dayHigh: null, dayLow: null, dayVolume: null, updated: ASKED, delayed: false,
  };
  return {
    symbol: 'TEST', question: 'Is it a good entry?', askedAt: ASKED, direction: null, reason: null, provider: 'fmp', quote,
    bars: { '4h': randomBars(300, 8, ASKED - 300 * 14_400, 14_400), '1D': daily, '1W': randomBars(300, 9, ASKED - 300 * 7 * DAY, 7 * DAY) },
    earnings: [
      { date: '2026-10-27', epsActual: null, epsEstimate: 1.2, revenueActual: null, revenueEstimate: null },
      { date: '2026-07-28', epsActual: 1.1, epsEstimate: 1.0, revenueActual: 10, revenueEstimate: 9 },
    ],
    analysts: { targetHigh: 200, targetLow: 50, targetConsensus: 150, targetMedian: 150, strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, consensus: 'Buy' },
    news: [],
    ...over,
  };
}

/** Every number in the object, with its path. */
function numbers(v: unknown, path = '$'): [string, number][] {
  if (typeof v === 'number') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => numbers(x, `${path}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => numbers(x, `${path}.${k}`));
  return [];
}

describe('sessionsBetween', () => {
  it('counts weekdays and skips weekends', () => {
    expect(sessionsBetween('2026-10-16', '2026-10-27')).toBe(7); // Fri → Tue of the week after next
    expect(sessionsBetween('2026-10-16', '2026-10-16')).toBe(0);
    expect(sessionsBetween('2026-10-19', '2026-10-16')).toBe(-1);
  });
});

describe('buildFacts', () => {
  const f = buildFacts(input());

  it('has no NaN or infinite number', () => {
    const bad = numbers(f).filter(([, n]) => !Number.isFinite(n));
    expect(bad).toEqual([]);
  });

  it('plans both sides when the question has no direction', () => {
    expect(new Set(f.plans.map((p) => p.side))).toEqual(new Set(['long', 'short']));
    expect(f.plans.every((p) => p.kind !== 'market' || p.entryType === 'market')).toBe(true);
  });

  it('gives each MA a signed distance and the matching word', () => {
    expect(f.mas.map((m) => m.name)).toEqual(['EMA20', 'EMA50', 'EMA200']);
    for (const m of f.mas) expect(m.distancePct >= 0).toBe(m.position === 'above');
  });

  it('counts the confluence rows itself', () => {
    const { rows, bullish, bearish, neutral } = f.confluence;
    expect(bullish + bearish + neutral).toBe(rows.length);
    expect(rows.filter((r) => r.arrow === 'up')).toHaveLength(bullish);
  });

  it('makes every chart line from a plan', () => {
    const planPrices = new Set(f.plans.flatMap((p) => [p.entryLow, p.entryHigh, p.stop, ...p.targets.map((t) => t.price)]));
    for (const l of f.marks.lines) expect(planPrices.has(l.price)).toBe(true);
  });

  it('counts the sessions to earnings and marks 0.5% size inside 10 sessions', () => {
    expect(f.earnings).toEqual({ next: '2026-10-27', sessionsAway: 7 });
    expect(f.plans.every((p) => p.sizePct === 0.5 && p.sizeReason?.includes('earnings in 7 sessions'))).toBe(true);
  });

  it('flags a partial session and lists missing data', () => {
    expect(f.dataCheck.partialSession).toBe(true);
    expect(f.dataCheck.stale).toBe(false);
    expect(f.dataCheck.missing).toContain('news');
  });

  it('flags stale data (the CAT problem of sample 001)', () => {
    const old = buildFacts(input({ askedAt: ASKED + 9 * DAY }));
    expect(old.dataCheck.stale).toBe(true);
    expect(old.dataCheck.staleDays).toBe(5); // Mon 10-19 to Fri 10-23; the question is on Sun 10-25
  });

  it('marks generated prices', () => {
    expect(buildFacts(input({ provider: 'synthetic' })).synthetic).toBe(true);
  });

  it('keeps to one side when the question has a direction', () => {
    expect(buildFacts(input({ direction: 'short' })).plans.every((p) => p.side === 'short')).toBe(true);
  });
});

describe('featuredPlan', () => {
  const plan = (kind: string, meetsTwoToOne: boolean, rr: number) => ({ kind, meetsTwoToOne, targets: [{ rr }] });

  it('prefers the pending plan with the best T1 R:R that reaches 2:1', () => {
    expect(featuredPlan([plan('market', true, 5), plan('retest', true, 2), plan('continuation', true, 3)])?.kind).toBe('continuation');
    expect(featuredPlan([plan('market', true, 1), plan('retest', false, 9)])?.kind).toBe('market');
    expect(featuredPlan([plan('market', false, 1)])).toBeNull();
  });

  it('draws at most one plan per side and the nearest zones', () => {
    const f = buildFacts(input());
    const sides = new Set(f.marks.lines.map((l) => l.label.split(' ')[0]));
    for (const side of sides) {
      expect(new Set(f.marks.lines.filter((l) => l.label.startsWith(side as string)).map((l) => l.label.split(' ')[1])).size).toBe(1);
    }
    expect(f.marks.zones.length).toBeLessThanOrEqual(MAX_ZONE_MARKS);
  });
});

