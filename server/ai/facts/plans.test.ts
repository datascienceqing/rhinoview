import { describe, expect, it } from 'vitest';
import { scoreConfluence } from './confluence';
import type { ConfluenceRow } from './confluence';
import { buildPlan, mergeLevels, plansFor, rangeExtensions } from './plans';

describe('buildPlan', () => {
  it('reproduces plan A of sample 001 (CAT retest short)', () => {
    // Entry 768–771, invalidation 771.39, ATR(4H) 20.32: stop 781.55; T1 702.99, T2 662.85.
    const p = buildPlan({
      kind: 'retest', side: 'short', entryType: 'limit', entryLow: 768, entryHigh: 771, trigger: 't',
      invalidation: { price: 771.39, label: 'broken swing low' }, atrLower: 20.32,
      targets: [{ price: 662.85, label: 'OB low' }, { price: 702.99, label: 'FVG floor' }],
      againstHigherTrend: false, earningsSessions: 14,
    });
    expect(p?.stop).toBeCloseTo(781.55, 2);
    expect(p?.rrEntry).toBe(768); // the lower R:R for a short
    expect(p?.targets.map((t) => t.price)).toEqual([702.99, 662.85]);
    expect(p?.targets[0]?.rr).toBeCloseTo(65.01 / 13.55, 6);
    expect(p?.targets[1]?.rr).toBeCloseTo(105.15 / 13.55, 6);
    expect(p?.targets[0]?.pct).toBeCloseTo(-8.46, 2);
    expect(p?.sizePct).toBe(1);
  });

  it('uses the higher entry for a long, and the same stop for every target', () => {
    const p = buildPlan({
      kind: 'retest', side: 'long', entryType: 'limit', entryLow: 15, entryHigh: 15.1, trigger: 't',
      invalidation: { price: 14.73, label: 'fib 0.786' }, atrLower: 0.4,
      targets: [{ price: 15.83, label: 'T1' }, { price: 16.48, label: 'T2' }, { price: 17.04, label: 'T3' }, { price: 18, label: 'T4' }],
      againstHigherTrend: true, earningsSessions: null,
    });
    expect(p?.rrEntry).toBe(15.1);
    expect(p?.stop).toBeCloseTo(14.53, 10);
    expect(p?.targets).toHaveLength(3);
    for (const t of p?.targets ?? []) expect(t.rr).toBeCloseTo((t.price - 15.1) / (15.1 - 14.53), 10);
    expect(p?.sizePct).toBe(0.5);
    expect(p?.sizeReason).toContain('against the higher-timeframe trend');
  });

  it('uses 0.5% with earnings in 10 sessions or less', () => {
    const p = buildPlan({
      kind: 'market', side: 'short', entryType: 'market', entryLow: 100, entryHigh: 100, trigger: 't',
      invalidation: { price: 105, label: 'x' }, atrLower: 2, targets: [{ price: 90, label: 'y' }],
      againstHigherTrend: false, earningsSessions: 10,
    });
    expect(p?.sizeReason).toBe('earnings in 10 sessions');
  });

  it('is null when the stop is not past the entry or no target is ahead', () => {
    const base = { kind: 'market', side: 'short', entryType: 'market', entryLow: 100, entryHigh: 100, trigger: 't', atrLower: 2, againstHigherTrend: false, earningsSessions: null } as const;
    expect(buildPlan({ ...base, invalidation: { price: 90, label: 'x' }, targets: [{ price: 80, label: 'y' }] })).toBeNull();
    expect(buildPlan({ ...base, invalidation: { price: 105, label: 'x' }, targets: [{ price: 110, label: 'y' }] })).toBeNull();
  });
});

describe('plansFor', () => {
  const ctx = {
    price: 733.24, atrDaily: 28.45, atrLower: 20.32,
    levels: [
      { price: 819.17, label: 'EMA50' }, { price: 789.81, label: 'swing high' }, { price: 771.39, label: 'broken swing low' },
      { price: 702.99, label: 'FVG floor' }, { price: 704, label: 'near-duplicate' }, { price: 662.85, label: 'OB low' }, { price: 627.5, label: 'swing low' },
    ],
    lastBearishBreak: { price: 771.39, label: 'broken swing low' }, lastBullishBreak: null,
    againstTrend: { long: true, short: false }, earningsSessions: 14,
  };

  it('makes the market, retest, and continuation shorts', () => {
    const plans = plansFor('short', ctx);
    expect(plans.map((p) => p.kind)).toEqual(['market', 'retest', 'continuation']);
    const [market, retest, cont] = plans;
    expect(market?.invalidation.price).toBe(771.39);
    expect(retest?.entryType).toBe('limit');
    expect(cont?.entryType).toBe('stop');
    expect(cont?.invalidation.price).toBe(702.99);
    // 704 is within 0.1 × ATR of 702.99, so it is merged away.
    expect(market?.targets.map((t) => t.price)).toEqual([702.99, 662.85, 627.5]);
  });

  it('has no retest without a break in the trade direction', () => {
    expect(plansFor('long', ctx).some((p) => p.kind === 'retest')).toBe(false);
  });

  it('merges levels nearer than the gap', () => {
    expect(mergeLevels([{ price: 10, label: 'a' }, { price: 10.05, label: 'b' }, { price: 11, label: 'c' }], 0.1).map((l) => l.label)).toEqual(['a', 'c']);
  });
});

describe('plans at a new high (AAPL, 2026-11-13)', () => {
  // Price 356.27 under the range high 360.83: no tested level is above the price.
  const range = { high: 360.83, low: 325.33 };
  const broken = { price: 351.73, label: 'broken resistance 351.73' };
  const ctx = {
    price: 356.27, atrDaily: 8.22, atrLower: 5.24,
    levels: [{ price: 354.41, label: 'bullish FVG top' }, { price: 351.73, label: 'bullish CHoCH level' }, { price: 338.7, label: 'swing low' }],
    lastBearishBreak: null, lastBullishBreak: broken, againstTrend: { long: false, short: true }, earningsSessions: null,
  };
  const withRange = { ...ctx, levels: [...ctx.levels, { price: range.high, label: 'range high' }, { price: range.low, label: 'range low' }], extensions: rangeExtensions(range) };

  it('projects the range height past each end', () => {
    const ext = rangeExtensions(range);
    expect(ext.long.map((l) => Number(l.price.toFixed(2)))).toEqual([370.49, 382.77]);
    expect(ext.short.map((l) => Number(l.price.toFixed(2)))).toEqual([315.67, 303.39]);
    expect(ext.long[0]).toMatchObject({ label: 'range extension 1.272', projected: true });
  });

  it('leaves out a projection that is not a positive price', () => {
    expect(rangeExtensions({ high: 10, low: 1 }).short).toEqual([]);
  });

  it('has no long plan without the range levels', () => {
    expect(plansFor('long', ctx)).toEqual([]);
  });

  it('makes the retest long with the range high as T1 and the extensions after it', () => {
    const retest = plansFor('long', withRange).find((p) => p.kind === 'retest');
    expect(retest?.entryLow).toBeCloseTo(351.73, 2);
    expect(retest?.entryHigh).toBeCloseTo(352.55, 2);
    expect(retest?.stop).toBeCloseTo(349.11, 2);
    expect(retest?.targets.map((t) => Number(t.price.toFixed(2)))).toEqual([360.83, 370.49, 382.77]);
    expect(retest?.targets.map((t) => t.label)).toEqual(['range high', 'range extension 1.272', 'range extension 1.618']);
    expect(retest?.targets[0]?.rr).toBeCloseTo(2.41, 1);
    expect(retest?.meetsTwoToOne).toBe(true);
  });

  it('uses only the extensions for the continuation long, and never as its trigger', () => {
    const cont = plansFor('long', withRange).find((p) => p.kind === 'continuation');
    expect(cont?.invalidation.price).toBe(360.83);
    expect(cont?.targets.map((t) => t.label)).toEqual(['range extension 1.272', 'range extension 1.618']);
  });

  it('does not use an extension as a level behind the price', () => {
    // Price at the range high: the long extension is above it, but it is not the invalidation of a short.
    const shorts = plansFor('short', { ...withRange, price: 360.83 });
    expect(shorts.find((p) => p.kind === 'market')).toBeUndefined();
    expect(shorts.length).toBeGreaterThan(0);
    for (const p of shorts) expect(p.invalidation.label).not.toContain('extension');
  });
});

describe('meetsTwoToOne', () => {
  const plan = (targets: number[]) =>
    buildPlan({
      kind: 'market', side: 'long', entryType: 'market', entryLow: 100, entryHigh: 100, trigger: 't',
      invalidation: { price: 99, label: 'level' }, atrLower: 2, // stop 98, risk 2
      targets: targets.map((price) => ({ price, label: 'T' })), againstHigherTrend: false, earningsSessions: null,
    });

  it('uses T2, not a far T3', () => {
    expect(plan([102, 103, 120])?.meetsTwoToOne).toBe(false); // T2 is 1.5:1; T3 is 10:1
    expect(plan([102, 104, 120])?.meetsTwoToOne).toBe(true); // T2 is 2:1
  });

  it('uses T1 when the plan has one target', () => {
    expect(plan([104])?.meetsTwoToOne).toBe(true);
    expect(plan([103])?.meetsTwoToOne).toBe(false);
  });
});

describe('scoreConfluence', () => {
  const row = (id: string, arrow: ConfluenceRow['arrow']): ConfluenceRow => ({ id, signal: id, reading: '', arrow });

  it('counts the rows, so 7 down, 1 neutral, 2 up is 7 of 10 (sample 003)', () => {
    const rows = [...'abcdefg'].map((c) => row(c, 'down')).concat([row('h', 'neutral'), row('i', 'up'), row('j', 'up')]);
    const r = scoreConfluence(rows, null);
    expect([r.bearish, r.neutral, r.bullish]).toEqual([7, 1, 2]);
    expect(r.side).toBe('short');
    expect(r.withPct).toBe(70);
    expect(r.conviction).toBe('moderate');
  });

  it('calls 50% no bias (sample 005)', () => {
    const rows = [row('a', 'up'), row('b', 'up'), row('c', 'up'), row('d', 'down'), row('e', 'down'), row('f', 'down')];
    expect(scoreConfluence(rows, 'long').conviction).toBe('none');
  });

  it('caps high conviction when exhaustion is against the side', () => {
    const rows = [...'abcdefgh'].map((c) => row(c, 'down')).concat([row('exhaustion', 'up')]);
    const r = scoreConfluence(rows, 'short');
    expect(r.withPct).toBeCloseTo(88.9, 1);
    expect(r.conviction).toBe('moderate');
    expect(r.cappedByExhaustion).toBe(true);
  });
});
