import { describe, expect, it } from 'vitest';
import type { Bar, ConfluenceParams } from '@shared/types';
import { buildClusters, computeConfluence, rankClusters } from './confluence';
import type { ConfluenceCluster, ConfluenceResult } from './confluence';
import { randomBars as randomBarsFrom } from './fixtures';
import { DEFAULT_PARAMS, InvalidIndicatorParamsError } from './types';

// Bars from [open, high, low, close, volume?] rows. Time = index * 1 day.
type Row = [number, number, number, number, number?];
const T0 = 1_700_000_000;
const DAY = 86_400;
function bars(rows: readonly Row[]): Bar[] {
  return rows.map(([open, high, low, close, volume = 100], i) => ({
    time: T0 + i * DAY,
    open,
    high,
    low,
    close,
    volume,
    vwap: null,
    transactions: null,
  }));
}

/**
 * Small params for hand-made series: with fewer than 10 bars no average and no swing
 * level is defined, so the pivots (1 bar each side) are the only candidates, and every
 * bar passes the volume check (length 1, multiplier 1).
 */
const P = (over: Partial<ConfluenceParams> = {}): ConfluenceParams => ({
  ...DEFAULT_PARAMS.confluence,
  swingLookback: 20,
  pivotLeft: 1,
  pivotRight: 1,
  volumeLength: 1,
  volumeMult: 1,
  breakdownMinConfluence: 1,
  breakdownMinDistancePct: 0,
  ...over,
});
const eventBars = (r: ConfluenceResult) => r.events.map((e) => e.index);
const c = (bottom: number, top: number, count: number): ConfluenceCluster => ({ bottom, top, count });

/**
 * Turn: a pivot high at 12 (bar 1) is confirmed at bar 2, so the trigger at bar 2 is 12.
 * Bar 3 closes at 12.5 on enough volume: a breakout of the previous bar's trigger.
 */
const TURN: Row[] = [
  [9.5, 10, 9, 9.5],
  [10.5, 12, 10, 11],
  [10.5, 11, 9.5, 10],
  [11, 13, 11, 12.5],
];

/**
 * Breakdown: a pivot low at 9 (bar 1) is confirmed at bar 2, so the trigger is 9 from bar 2.
 * Bar 4 closes at 8.6, low in its range: a breakdown. Bar 5 stays below 9. Bar 6 closes
 * back above 9. Bar 7 closes below 9 again.
 */
const BREAKDOWN: Row[] = [
  [10.5, 11, 10, 10.5],
  [10, 10.2, 9, 9.5],
  [9.8, 10.5, 9.5, 10.3],
  [10.3, 10.6, 10, 10.4],
  [10, 10.1, 8.5, 8.6],
  [8.6, 8.8, 8.3, 8.4],
  [8.5, 9.8, 8.5, 9.5],
  [9.5, 9.6, 8.7, 8.8],
];

describe('clusters (plan 4.4)', () => {
  it('merges a level whose gap to the previous level is within the tolerance, including a gap equal to it', () => {
    expect(buildClusters([10, 10.5, 11, 12], 0.5, Infinity)).toEqual([c(10, 11, 3), c(12, 12, 1)]);
  });

  it('counts equal levels separately', () => {
    expect(buildClusters([10, 10, 10], 0.1, Infinity)).toEqual([c(10, 10, 3)]);
  });

  it('chains small gaps without limit, and stops a chain at the band-width cap', () => {
    const chain = [10, 10.4, 10.8, 11.2, 11.6];
    expect(buildClusters(chain, 0.5, Infinity)).toEqual([c(10, 11.6, 5)]);
    expect(buildClusters(chain, 0.5, 1)).toEqual([c(10, 10.8, 3), c(11.2, 11.6, 2)]);
  });

  it('gives no cluster for no levels', () => {
    expect(buildClusters([], 0.5, Infinity)).toEqual([]);
  });
});

describe('triggers (plan 4.5)', () => {
  it('ranks a higher count first, and the next one second', () => {
    const r = rankClusters([c(101, 102, 2), c(105, 106, 4), c(110, 110, 3)], 100, 'turn', 1, 0);
    expect(r).toEqual({ primary: c(105, 106, 4), secondary: c(110, 110, 3) });
  });

  it('on equal counts, takes the band nearer the price: the lower top above, the higher top below', () => {
    expect(rankClusters([c(110, 111, 2), c(104, 105, 2)], 100, 'turn', 1, 0).primary).toEqual(c(104, 105, 2));
    expect(rankClusters([c(90, 91, 2), c(95, 96, 2)], 100, 'breakdown', 1, 0).primary).toEqual(c(95, 96, 2));
  });

  it('applies the minimum count', () => {
    const r = rankClusters([c(101, 101, 1), c(103, 104, 2)], 100, 'turn', 2, 0);
    expect(r).toEqual({ primary: c(103, 104, 2), secondary: null });
  });

  it('measures the distance from the near edge: the bottom above, the top below', () => {
    // 1 % of 100: a band above must start at 101 or higher; a band below must end at 99 or lower.
    expect(rankClusters([c(100.5, 103, 5)], 100, 'turn', 1, 1).primary).toBeNull();
    expect(rankClusters([c(101, 103, 5)], 100, 'turn', 1, 1).primary).toEqual(c(101, 103, 5));
    expect(rankClusters([c(97, 99.5, 5)], 100, 'breakdown', 1, 1).primary).toBeNull();
    expect(rankClusters([c(97, 99, 5)], 100, 'breakdown', 1, 1).primary).toEqual(c(97, 99, 5));
  });
});

describe('mode turn: breakouts (plan 4.6)', () => {
  it('fires on a close above the PREVIOUS bar trigger, which the Turn script misses', () => {
    const r = computeConfluence(bars(TURN), P());
    expect(r.events).toEqual([{ index: 3, time: T0 + 3 * DAY, level: 12, count: 1, latched: false }]);
    // The script compares with the same bar's trigger. At bar 3 every candidate above the
    // close is gone, so that comparison has nothing to break.
    expect(r.last?.trigger).toBeNull();
  });

  it('does not fire on a close at the trigger', () => {
    const rows: Row[] = [...TURN.slice(0, 3), [11, 12.5, 11, 12]];
    expect(computeConfluence(bars(rows), P()).events).toEqual([]);
  });

  it('needs the volume check: a defined average, and the multiplier', () => {
    expect(computeConfluence(bars(TURN), P({ volumeLength: 5 })).events).toEqual([]);
    const quiet: Row[] = TURN.map(([o, h, l, cl], i) => [o, h, l, cl, i === 3 ? 140 : 100]);
    expect(eventBars(computeConfluence(bars(quiet), P({ volumeLength: 2, volumeMult: 1.5 })))).toEqual([]);
    expect(eventBars(computeConfluence(bars(quiet), P({ volumeLength: 2, volumeMult: 1.15 })))).toEqual([3]);
  });

  it('does not use the close quality', () => {
    const highClose: Row[] = [...TURN.slice(0, 3), [11, 12.6, 11, 12.5]];
    expect(eventBars(computeConfluence(bars(highClose), P({ closeQuality: 0.1 })))).toEqual([3]);
  });

  it('ignores a candidate equal to the close, in both modes', () => {
    const rows: Row[] = [...TURN.slice(0, 2), [11, 12, 11, 12]];
    expect(computeConfluence(bars(rows), P()).last?.primary).toBeNull();
    expect(computeConfluence(bars(rows), P({ mode: 'breakdown' })).last?.primary).toBeNull();
  });
});

describe('mode breakdown: breakdowns (plan 4.6, 4.8)', () => {
  it('fires on a close below the previous bar trigger, each time the lagged trigger allows it', () => {
    const r = computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown' }));
    expect(r.events).toEqual([
      { index: 4, time: T0 + 4 * DAY, level: 9, count: 1, latched: false },
      { index: 7, time: T0 + 7 * DAY, level: 9, count: 1, latched: false },
    ]);
    expect(r.last?.broken).toEqual({ index: 7, price: 9 });
  });

  it('needs the close in the lower part of the bar range', () => {
    // Bar 4: close 8.9 in a range 8.0..10.1 sits at 0.43 of the range.
    const rows: Row[] = [...BREAKDOWN.slice(0, 4), [10, 10.1, 8, 8.9]];
    expect(eventBars(computeConfluence(bars(rows), P({ mode: 'breakdown', closeQuality: 0.4 })))).toEqual([]);
    expect(eventBars(computeConfluence(bars(rows), P({ mode: 'breakdown', closeQuality: 0.45 })))).toEqual([4]);
  });

  it('passes the close quality on a bar with no range', () => {
    const rows: Row[] = [...BREAKDOWN.slice(0, 4), [8.6, 8.6, 8.6, 8.6]];
    expect(eventBars(computeConfluence(bars(rows), P({ mode: 'breakdown', closeQuality: 0.1 })))).toEqual([4]);
  });

  it('has no broken level before the first breakdown, and none in mode turn', () => {
    expect(computeConfluence(bars(BREAKDOWN.slice(0, 4)), P({ mode: 'breakdown' })).last?.broken).toBeNull();
    expect(computeConfluence(bars(BREAKDOWN), P()).last?.broken).toBeNull();
  });
});

describe('the latch (plan 4.9)', () => {
  const at = (bar: number) => T0 + bar * DAY;

  it('reports the bar where the lock formed, which can come after the latch bar', () => {
    // The first primary cluster exists at bar 2, when the pivot high of bar 1 is confirmed.
    const r = computeConfluence(bars(TURN), P({ latch: 'on', latchTime: at(0) }));
    expect(r.latch).toMatchObject({ index: 0, holds: true, lockIndex: 2 });
    expect(computeConfluence(bars(TURN), P({ latch: 'off', latchTime: at(0) })).latch.lockIndex).toBeNull();
  });

  it('breakdown: locks at the first active bar with a primary, and fires once per break', () => {
    const r = computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown', latch: 'on', latchTime: at(2) }));
    expect(r.latch).toEqual({ index: 2, holds: true, lockIndex: 2 });
    expect(r.last?.primary).toEqual(c(9, 9, 1));
    expect(r.last?.latched).toBe(true);
    // Bar 5 is still below the locked 9: no second event. Bar 6 closes above 9 (re-arm); bar 7 breaks again.
    expect(r.events.map((e) => [e.index, e.level, e.latched])).toEqual([
      [4, 9, true],
      [7, 9, true],
    ]);
  });

  it('breakdown: without a close back above the locked level, there is no second event', () => {
    const rows: Row[] = [...BREAKDOWN.slice(0, 6), [8.5, 9.1, 8.5, 8.95], [8.9, 8.95, 8.7, 8.8]];
    const r = computeConfluence(bars(rows), P({ mode: 'breakdown', latch: 'on', latchTime: at(2) }));
    expect(eventBars(r)).toEqual([4]);
  });

  it('breakdown: the locked level replaces the lagged live trigger', () => {
    // The lock takes 9 at bar 2. A second pivot low at 9.8 (bar 3) raises the live trigger to 9.8
    // from bar 4. Bar 5 closes below both: the live event uses 9.8, the locked one 9.
    const rows: Row[] = [
      [10.5, 11, 10, 10.5],
      [10, 10.2, 9, 9.5],
      [10, 10.5, 10, 10.3],
      [10.3, 10.6, 9.8, 10.4],
      [10.4, 10.7, 10, 10.5],
      [10, 10.1, 8.5, 8.6],
    ];
    const live = computeConfluence(bars(rows), P({ mode: 'breakdown' }));
    const locked = computeConfluence(bars(rows), P({ mode: 'breakdown', latch: 'on', latchTime: at(2) }));
    expect(live.events.map((e) => e.level)).toEqual([9.8]);
    expect(locked.events.map((e) => e.level)).toEqual([9]);
  });

  it('turn: the mirror — one event above the locked level, a re-arm below it, then one more', () => {
    const rows: Row[] = [
      ...TURN,
      [12.5, 13.5, 12.2, 13],
      [12.5, 12.8, 11.5, 11.8],
      [12, 12.9, 11.9, 12.6],
    ];
    const r = computeConfluence(bars(rows), P({ latch: 'on', latchTime: at(2) }));
    expect(r.events.map((e) => [e.index, e.level, e.latched])).toEqual([
      [3, 12, true],
      [6, 12, true],
    ]);
    const noRearm: Row[] = [...rows.slice(0, 5), [12.5, 12.8, 12.05, 12.1], rows[6] as Row];
    expect(eventBars(computeConfluence(bars(noRearm), P({ latch: 'on', latchTime: at(2) })))).toEqual([3]);
  });

  it('waits for a primary: the lock comes at the first active bar that has one', () => {
    const r = computeConfluence(bars(TURN), P({ latch: 'on', latchTime: at(0) }));
    expect(r.latch.index).toBe(0);
    expect(eventBars(r)).toEqual([3]);
    expect(r.events[0]?.latched).toBe(true);
    expect(r.last?.primary).toEqual(c(12, 12, 1)); // locked at bar 2; the live primary at bar 3 is null
  });

  it('is active from bar 0 when the latch date is before the first bar', () => {
    const r = computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown', latch: 'on', latchTime: T0 - 30 * DAY }));
    expect(r.latch.index).toBe(0);
    expect(r.last?.latched).toBe(true);
  });

  it('is not active before the latch date, and has no index after the last bar', () => {
    const r = computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown', latch: 'on', latchTime: at(100) }));
    expect(r.latch).toEqual({ index: null, holds: false, lockIndex: null });
    expect(r.events).toEqual(computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown' })).events);
  });

  it('has no effect with latchTime 0, or with the latch off', () => {
    const plain = computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown' }));
    for (const over of [{ latch: 'on', latchTime: 0 }, { latch: 'off', latchTime: at(2) }] as const) {
      const r = computeConfluence(bars(BREAKDOWN), P({ mode: 'breakdown', ...over }));
      expect(r.events).toEqual(plain.events);
      expect(r.latch).toEqual({ index: null, holds: false, lockIndex: null });
      expect(r.last).toEqual(plain.last);
    }
  });
});

/** Highs alternate 20 and 16, lows 14 and 10, closes stay at 15: a pivot high every 2 bars. */
function zigzag(n: number): Row[] {
  return Array.from({ length: n }, (_, i): Row => (i % 2 === 0 ? [15, 20, 14, 15] : [15, 16, 10, 15]));
}

describe('pivots in the candidates (plan 4.2)', () => {
  it('keeps at most 50 pivots per side', () => {
    // At 20: the retained pivot highs plus the swing high. The other levels are not near 20.
    const r = computeConfluence(bars(zigzag(240)), P({ pivotMaxAge: 5000 }));
    expect(r.last?.primary).toEqual(c(20, 20, 51));
  });

  it('drops a pivot older than the max age', () => {
    // At t = 239 the pivot highs with t - p <= 10 are 230, 232, ..., 238: 5 pivots, plus the swing high.
    const r = computeConfluence(bars(zigzag(240)), P({ pivotMaxAge: 10 }));
    expect(r.last?.primary).toEqual(c(20, 20, 6));
  });
});

describe('invalidation (plan 4.7)', () => {
  // A pivot high at 12 and a pivot low at 8 early on, then 30 flat bars that make no pivots.
  const rows: Row[] = [
    [10, 10.5, 9.5, 10],
    [10, 12, 9.6, 10],
    [10, 10.5, 8, 10],
    [10, 10.5, 9.5, 10],
    ...Array.from({ length: 30 }, (): Row => [10, 10.5, 9.5, 10]),
  ];

  it('turn: the latest pivot low of any age', () => {
    expect(computeConfluence(bars(rows), P({ pivotMaxAge: 10 })).last?.invalidation).toEqual({ index: 2, price: 8 });
  });

  it('breakdown: the latest retained pivot high, which ages out', () => {
    expect(computeConfluence(bars(rows.slice(0, 10)), P({ mode: 'breakdown', pivotMaxAge: 10 })).last?.invalidation).toEqual({
      index: 1,
      price: 12,
    });
    expect(computeConfluence(bars(rows), P({ mode: 'breakdown', pivotMaxAge: 10 })).last?.invalidation).toBeNull();
  });
});

/** Random bars with volume spikes, so events happen with the default params. */
const randomBars = (n: number, seed: number) => randomBarsFrom(n, seed, T0, DAY);

describe('sources and swing levels (plan 4.1)', () => {
  it('has no swing level and no Fibonacci level before swingLookback bars', () => {
    const r = computeConfluence(randomBars(19, 7), P());
    expect(r.last?.sources.filter((s) => s.kind === 'fib')).toEqual([]);
  });

  it('has the five Fibonacci levels of the last swingLookback bars', () => {
    const b = randomBars(300, 7);
    for (const n of [20, 21, 150, 300]) {
      const window = b.slice(n - 20, n);
      const H = Math.max(...window.map((x) => x.high));
      const L = Math.min(...window.map((x) => x.low));
      const fibs = computeConfluence(b.slice(0, n), P()).last?.sources.filter((s) => s.kind === 'fib') ?? [];
      expect(fibs.map((f) => f.name)).toEqual(['Fib 0.236', 'Fib 0.382', 'Fib 0.500', 'Fib 0.618', 'Fib 0.786']);
      [0.236, 0.382, 0.5, 0.618, 0.786].forEach((r, i) => expect(fibs[i]?.value).toBeCloseTo(L + (H - L) * r, 10));
    }
  });

  it('adds each moving average after its warmup', () => {
    const names = (n: number) => computeConfluence(randomBars(n, 3), P()).last?.sources.filter((s) => s.kind === 'ma').map((s) => s.name);
    expect(names(9)).toEqual([]);
    expect(names(10)).toEqual(['EMA 10']);
    expect(names(50)).toEqual(['EMA 10', 'EMA 20', 'EMA 50', 'SMA 50']);
    expect(names(200)).toEqual(['EMA 10', 'EMA 20', 'EMA 50', 'SMA 50', 'SMA 100', 'SMA 200']);
  });
});

describe('no look-ahead (plan 4.11)', () => {
  const full = randomBars(700, 99);
  const cases: [string, ConfluenceParams][] = [
    ['turn', { ...DEFAULT_PARAMS.confluence }],
    ['breakdown', { ...DEFAULT_PARAMS.confluence, mode: 'breakdown' }],
    ['turn, latched', { ...DEFAULT_PARAMS.confluence, latch: 'on', latchTime: T0 + 400 * DAY }],
    ['breakdown, latched', { ...DEFAULT_PARAMS.confluence, mode: 'breakdown', latch: 'on', latchTime: T0 + 400 * DAY }],
  ];

  it.each(cases)('%s: the events up to bar k do not change when more bars arrive', (_label, params) => {
    const all = computeConfluence(full, params);
    expect(all.events.length).toBeGreaterThan(0);
    for (let k = 260; k < full.length; k += 37) {
      const cut = computeConfluence(full.slice(0, k + 1), params);
      expect(cut.events).toEqual(all.events.filter((e) => e.index <= k));
    }
  });
});

describe('edge cases', () => {
  it('returns no state for no bars', () => {
    expect(computeConfluence([], DEFAULT_PARAMS.confluence)).toEqual({
      mode: 'turn',
      events: [],
      last: null,
      latch: { index: null, holds: false, lockIndex: null },
    });
  });

  it('throws on invalid params', () => {
    expect(() => computeConfluence(bars(TURN), { ...DEFAULT_PARAMS.confluence, tolerancePct: 0 })).toThrow(InvalidIndicatorParamsError);
  });

  it('computes 10 000 bars with the default params in less than 200 ms', () => {
    const b = randomBars(10_000, 5);
    computeConfluence(b, DEFAULT_PARAMS.confluence); // warm the JIT
    const start = performance.now();
    computeConfluence(b, DEFAULT_PARAMS.confluence);
    computeConfluence(b, { ...DEFAULT_PARAMS.confluence, mode: 'breakdown' });
    expect((performance.now() - start) / 2).toBeLessThan(200);
  });
});
