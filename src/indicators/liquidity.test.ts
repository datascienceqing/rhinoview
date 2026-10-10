import { describe, expect, it } from 'vitest';
import type { Bar, LiquidityParams } from '@shared/types';
import { computeLiquidity } from './liquidity';
import type { LiquidityResult, LiquiditySweep, LiquidityZone } from './liquidity';
import { InvalidIndicatorParamsError } from './types';

// Bars from [open, high, low, close, volume?] rows. Time = index * 1 day.
type Row = [number, number, number, number, number?];
const T0 = 1_700_000_000;
function bars(rows: readonly Row[]): Bar[] {
  return rows.map(([open, high, low, close, volume = 100], i) => ({
    time: T0 + i * 86_400,
    open,
    high,
    low,
    close,
    volume,
    vwap: null,
    transactions: null,
  }));
}

/** A quiet bar near 100 that touches no zone above 103 or below 97. */
const Q: Row = [100, 101, 99, 100];

const P = (over: Partial<LiquidityParams> = {}): LiquidityParams => ({
  lookback: 2,
  zoneMode: 'wick',
  sweepMode: 'both',
  minTouches: 0,
  maxAge: 10,
  sweepExtend: 3,
  ...over,
});

const highs = (r: LiquidityResult) => r.zones.filter((z) => z.side === 'high');
const lows = (r: LiquidityResult) => r.zones.filter((z) => z.side === 'low');
const only = <T,>(list: readonly T[]): T => {
  expect(list).toHaveLength(1);
  return list[0] as T;
};

// A high pivot at bar 2 (high 110, body 101..104), confirmed at bar 4 with L = 2.
const HIGH_PIVOT: Row[] = [Q, [100, 102, 99, 101], [101, 110, 100, 104], [104, 105, 103, 104], [104, 106, 102, 103]];
// A low pivot at bar 2 (low 90, body 93..96), confirmed at bar 4 with L = 2.
const LOW_PIVOT: Row[] = [Q, [100, 101, 98, 99], [96, 97, 90, 93], [93, 95, 92, 94], [94, 95, 91, 94]];

describe('4.1 pivots', () => {
  it('finds a high pivot and a low pivot, confirmed L bars later', () => {
    const h = only(highs(computeLiquidity(bars(HIGH_PIVOT), P())));
    expect(h).toMatchObject({ pivotIndex: 2, confirmIndex: 4, pivotTime: T0 + 2 * 86_400 });
    const l = only(lows(computeLiquidity(bars(LOW_PIVOT), P())));
    expect(l).toMatchObject({ pivotIndex: 2, confirmIndex: 4 });
  });

  it('knows nothing of a pivot before its confirmation bar', () => {
    expect(highs(computeLiquidity(bars(HIGH_PIVOT.slice(0, 4)), P()))).toEqual([]);
  });

  it('gives one pivot for a flat top of equal highs: the first bar', () => {
    const flat: Row[] = [Q, [100, 102, 99, 101], [101, 110, 100, 104], [104, 110, 103, 105], [104, 106, 102, 103], [103, 104, 101, 102]];
    expect(only(highs(computeLiquidity(bars(flat), P()))).pivotIndex).toBe(2);
  });

  it('gives one pivot for equal lows: the first bar', () => {
    const flat: Row[] = [Q, [100, 101, 98, 99], [96, 97, 90, 93], [93, 95, 90, 94], [94, 95, 91, 94], [94, 96, 92, 95]];
    expect(only(lows(computeLiquidity(bars(flat), P()))).pivotIndex).toBe(2);
  });

  it('is strict on the left: a bar equal to an earlier high is not a pivot', () => {
    // Bar 2 equals bar 1's high, so bar 2 is not a pivot; bar 1 has only one bar to its left.
    const rows: Row[] = [Q, [101, 110, 100, 104], [104, 110, 103, 105], [104, 106, 102, 103], [103, 104, 101, 102]];
    expect(highs(computeLiquidity(bars(rows), P()))).toEqual([]);
  });

  it('needs L bars on each side: the last L bars and the first L bars hold no pivot', () => {
    const late: Row[] = [Q, Q, [100, 102, 99, 101], [101, 110, 100, 104], [104, 105, 103, 104]];
    expect(highs(computeLiquidity(bars(late), P()))).toEqual([]);
    const early: Row[] = [[101, 110, 100, 104], [104, 105, 103, 104], [104, 106, 102, 103], Q, Q];
    expect(highs(computeLiquidity(bars(early), P()))).toEqual([]);
  });

  it('returns nothing for fewer than 2L + 1 bars, and for no bars', () => {
    expect(computeLiquidity(bars(HIGH_PIVOT.slice(0, 4)), P())).toEqual({ zones: [], sweeps: [] });
    expect(computeLiquidity([], P())).toEqual({ zones: [], sweeps: [] });
  });
});

describe('4.2 zones', () => {
  it('wick mode: a high zone spans the upper wick, a low zone the lower wick', () => {
    expect(only(highs(computeLiquidity(bars(HIGH_PIVOT), P())))).toMatchObject({ top: 110, bottom: 104, level: 110 });
    expect(only(lows(computeLiquidity(bars(LOW_PIVOT), P())))).toMatchObject({ top: 93, bottom: 90, level: 90 });
  });

  it('range mode: both zones span the whole bar', () => {
    const p = P({ zoneMode: 'range' });
    expect(only(highs(computeLiquidity(bars(HIGH_PIVOT), p)))).toMatchObject({ top: 110, bottom: 100, level: 110 });
    expect(only(lows(computeLiquidity(bars(LOW_PIVOT), p)))).toMatchObject({ top: 97, bottom: 90, level: 90 });
  });
});

describe('4.3 zone life', () => {
  it('is active at the last bar while nothing closes it', () => {
    const z = only(highs(computeLiquidity(bars([...HIGH_PIVOT, Q]), P())));
    expect(z).toMatchObject({ status: 'active', endIndex: 5 });
  });

  it('breaks on the first close past the level, here the first bar after confirmation', () => {
    const z = only(highs(computeLiquidity(bars([...HIGH_PIVOT, [105, 112, 104, 111], Q]), P())));
    expect(z).toMatchObject({ status: 'broken', endIndex: 5 });
  });

  it('a close exactly at the level is a sweep, not a break', () => {
    const r = computeLiquidity(bars([...HIGH_PIVOT, [105, 112, 104, 110], Q]), P());
    expect(only(highs(r))).toMatchObject({ status: 'active' });
    expect(only(r.sweeps)).toMatchObject({ kind: 'wick', index: 5 });
  });

  it('a low zone breaks on a close below its bottom', () => {
    const z = only(lows(computeLiquidity(bars([...LOW_PIVOT, [94, 95, 88, 89]]), P())));
    expect(z).toMatchObject({ status: 'broken', endIndex: 5 });
  });

  it('expires maxAge bars after the pivot bar, and stays with its end bar', () => {
    const rows: Row[] = [...HIGH_PIVOT, ...Array.from({ length: 12 }, () => Q)];
    const z = only(highs(computeLiquidity(bars(rows), P({ maxAge: 10 }))));
    expect(z).toMatchObject({ status: 'expired', endIndex: 12 });
  });

  it('a break on the expiry bar is a break', () => {
    const rows: Row[] = [...HIGH_PIVOT, ...Array.from({ length: 7 }, () => Q), [105, 112, 104, 111], Q];
    expect(only(highs(computeLiquidity(bars(rows), P({ maxAge: 10 }))))).toMatchObject({ status: 'broken', endIndex: 12 });
  });

  it('with maxAge <= L the zone is expired when it is confirmed, with no sweeps', () => {
    const rows: Row[] = [Q, Q, Q, Q, Q, Q, Q, Q, Q, Q, Q, [101, 110, 100, 104], ...Array.from({ length: 11 }, () => [104, 106, 102, 103] as Row), [104, 112, 103, 109]];
    const r = computeLiquidity(bars(rows), P({ lookback: 11, maxAge: 10 }));
    expect(only(highs(r))).toMatchObject({ pivotIndex: 11, confirmIndex: 22, status: 'expired', endIndex: 21 });
    expect(r.sweeps).toEqual([]);
  });
});

describe('4.4 touches and volume', () => {
  it('counts bars after the pivot bar that overlap the zone, including the bars before confirmation', () => {
    // Bars 3 and 4 overlap 104..110; bar 5 does not (Q); bar 6 overlaps.
    const rows: Row[] = [...HIGH_PIVOT.slice(0, 3), [104, 105, 103, 104, 10], [104, 106, 102, 103, 20], Q, [104, 105, 103, 104, 40]];
    const z = only(highs(computeLiquidity(bars(rows), P())));
    expect(z).toMatchObject({ touches: 3, volume: 70 });
  });

  it('does not count the pivot bar, and counts the bar that closes the zone', () => {
    const rows: Row[] = [...HIGH_PIVOT.slice(0, 2), [101, 110, 100, 104, 1000], Q, Q, [105, 112, 104, 111, 7], [109, 113, 108, 112, 5]];
    const z = only(highs(computeLiquidity(bars(rows), P())));
    expect(z).toMatchObject({ status: 'broken', endIndex: 5, touches: 1, volume: 7 });
  });

  it('needs the range to overlap: a bar that only reaches the bottom does not touch', () => {
    const rows: Row[] = [...HIGH_PIVOT.slice(0, 3), [103, 104, 102, 103], [102, 103, 101, 102]];
    expect(only(highs(computeLiquidity(bars(rows), P())))).toMatchObject({ touches: 0 });
  });

  it('adds zero volume as zero', () => {
    const rows = HIGH_PIVOT.map(([o, h, l, c]) => [o, h, l, c, 0] as Row);
    expect(only(highs(computeLiquidity(bars(rows), P())))).toMatchObject({ touches: 2, volume: 0 });
  });

  it('hides a zone with fewer than minTouches touches', () => {
    expect(highs(computeLiquidity(bars(HIGH_PIVOT), P({ minTouches: 2 })))).toHaveLength(1);
    expect(highs(computeLiquidity(bars(HIGH_PIVOT), P({ minTouches: 3 })))).toEqual([]);
  });
});

describe('4.5 sweeps', () => {
  const WICK_HIGH: Row = [104, 112, 103, 109];

  it('a wick through a high zone that closes back is a bearish wick sweep; the zone stays active', () => {
    const r = computeLiquidity(bars([...HIGH_PIVOT, WICK_HIGH]), P());
    const s = only(r.sweeps);
    expect(s).toMatchObject({ kind: 'wick', side: 'high', direction: 'bearish', index: 5, level: 110, extreme: 112 });
    expect(only(highs(r)).status).toBe('active');
  });

  it('a wick through a low zone that closes back is a bullish wick sweep', () => {
    const s = only(computeLiquidity(bars([...LOW_PIVOT, [94, 95, 88, 91]]), P()).sweeps);
    expect(s).toMatchObject({ kind: 'wick', side: 'low', direction: 'bullish', index: 5, level: 90, extreme: 88 });
  });

  it('gives at most one wick sweep per zone: the first', () => {
    const r = computeLiquidity(bars([...HIGH_PIVOT, WICK_HIGH, [104, 113, 103, 108]]), P());
    expect(only(r.sweeps).index).toBe(5);
  });

  it('a break is not a wick sweep, and no wick sweep comes after the break', () => {
    const r = computeLiquidity(bars([...HIGH_PIVOT, [105, 112, 104, 111], [111, 113, 111, 112]]), P({ sweepMode: 'wicks' }));
    expect(r.sweeps).toEqual([]);
  });

  it('a retest after a break of a high zone is bullish', () => {
    const rows: Row[] = [...HIGH_PIVOT, [105, 112, 104, 111], [111, 113, 109, 112]];
    const s = only(computeLiquidity(bars(rows), P()).sweeps);
    expect(s).toMatchObject({ kind: 'retest', side: 'high', direction: 'bullish', index: 6, level: 110, extreme: 109 });
  });

  it('a retest after a break of a low zone is bearish', () => {
    const rows: Row[] = [...LOW_PIVOT, [94, 95, 88, 89], [89, 91, 87, 88]];
    const s = only(computeLiquidity(bars(rows), P()).sweeps);
    expect(s).toMatchObject({ kind: 'retest', side: 'low', direction: 'bearish', index: 6, level: 90, extreme: 91 });
  });

  it('a retest needs a bar after the break bar, and only the first counts', () => {
    // The break bar itself dips below 110 and closes above: that is the break, not a retest.
    const rows: Row[] = [...HIGH_PIVOT, [109, 112, 108, 111], [111, 113, 109, 112], [112, 113, 108, 111]];
    const r = computeLiquidity(bars(rows), P());
    expect(only(r.sweeps)).toMatchObject({ kind: 'retest', index: 6 });
  });

  it('a retest can happen up to maxAge bars after the pivot bar, not later', () => {
    const before: Row[] = [...HIGH_PIVOT, [105, 112, 104, 111], ...Array.from({ length: 6 }, () => [112, 114, 111, 113] as Row)];
    const at = computeLiquidity(bars([...before, [111, 113, 109, 112]]), P({ maxAge: 10 })); // bar 12 = pivot + 10
    expect(only(at.sweeps)).toMatchObject({ kind: 'retest', index: 12 });
    const late = computeLiquidity(bars([...before, [112, 114, 111, 113], [111, 113, 109, 112]]), P({ maxAge: 10 }));
    expect(late.sweeps).toEqual([]);
  });

  it('an expired zone has no retest', () => {
    const rows: Row[] = [...HIGH_PIVOT, ...Array.from({ length: 9 }, () => Q), [105, 112, 104, 111], [111, 113, 109, 112]];
    const r = computeLiquidity(bars(rows), P({ maxAge: 10 }));
    expect(only(highs(r)).status).toBe('expired');
    expect(r.sweeps).toEqual([]);
  });

  it('the sweep mode chooses the events', () => {
    const rows: Row[] = [...HIGH_PIVOT, WICK_HIGH, [109, 112, 108, 111], [111, 113, 109, 112]];
    const kinds = (mode: LiquidityParams['sweepMode']) => computeLiquidity(bars(rows), P({ sweepMode: mode })).sweeps.map((s) => s.kind);
    expect(kinds('wicks')).toEqual(['wick']);
    expect(kinds('retests')).toEqual(['retest']);
    expect(kinds('both')).toEqual(['wick', 'retest']);
  });

  it('no sweep on the confirmation bar', () => {
    // Bar 4 (confirmation) cannot exceed the pivot high by the pivot rule; a low zone shows the same.
    const r = computeLiquidity(bars([...HIGH_PIVOT]), P());
    expect(r.sweeps).toEqual([]);
  });
});

describe('4.6 sweep area', () => {
  const base: Row[] = [...HIGH_PIVOT, [104, 112, 103, 109]]; // bearish wick sweep at bar 5, extreme 112

  it('spans from the level to the wick extreme', () => {
    expect(only(computeLiquidity(bars(base), P()).sweeps)).toMatchObject({ level: 110, extreme: 112 });
  });

  it('ends at the first later close past the extreme', () => {
    const s = only(computeLiquidity(bars([...base, Q, [110, 114, 109, 113], Q]), P({ sweepExtend: 5 })).sweeps);
    expect(s).toMatchObject({ endIndex: 7, open: false });
  });

  it('ends after sweepExtend bars', () => {
    const s = only(computeLiquidity(bars([...base, Q, Q, Q, Q, Q]), P({ sweepExtend: 3 })).sweeps);
    expect(s).toMatchObject({ endIndex: 8, open: false });
  });

  it('ends at the last bar, and stays open, when neither happened yet', () => {
    const s = only(computeLiquidity(bars([...base, Q]), P({ sweepExtend: 3 })).sweeps);
    expect(s).toMatchObject({ endIndex: 6, open: true });
  });

  it('a bullish area ends at the first close below the wick low', () => {
    const s = only(computeLiquidity(bars([...LOW_PIVOT, [94, 95, 88, 91], [91, 92, 86, 87]]), P({ sweepExtend: 5 })).sweeps);
    expect(s).toMatchObject({ direction: 'bullish', extreme: 88, endIndex: 6, open: false });
  });
});

describe('4.7 the sweep carries its zone volume', () => {
  it('carries the touch count and volume at the sweep bar, not later ones', () => {
    const rows: Row[] = [...HIGH_PIVOT.slice(0, 3), [104, 105, 103, 104, 10], [104, 106, 102, 103, 20], [104, 112, 103, 109, 30], [104, 106, 103, 105, 500]];
    const r = computeLiquidity(bars(rows), P());
    expect(only(r.sweeps)).toMatchObject({ touches: 3, volume: 60 });
    expect(only(highs(r))).toMatchObject({ touches: 4, volume: 560 });
  });

  it('a retest carries the volume of the broken zone', () => {
    const rows: Row[] = [...HIGH_PIVOT.slice(0, 3), [104, 105, 103, 104, 10], [104, 106, 102, 103, 20], [105, 112, 104, 111, 30], [111, 113, 109, 112, 999]];
    expect(only(computeLiquidity(bars(rows), P()).sweeps)).toMatchObject({ kind: 'retest', touches: 3, volume: 60 });
  });

  it('minTouches applies to the count a sweep carries', () => {
    const rows: Row[] = [...HIGH_PIVOT, [104, 112, 103, 109]]; // 3 touches at the sweep bar
    expect(computeLiquidity(bars(rows), P({ minTouches: 3 })).sweeps).toHaveLength(1);
    expect(computeLiquidity(bars(rows), P({ minTouches: 4 })).sweeps).toEqual([]);
  });
});

// ─────────────────────────── 4.8 no look-ahead ───────────────────────────

/** A random OHLC walk with varied wicks and volumes, deterministic. */
function ohlcWalk(n: number, seed: number): Bar[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(5, open + (rnd() - 0.5) * 4);
    const high = Math.max(open, close) + rnd() * 2;
    const low = Math.min(open, close) - rnd() * 2;
    // Round to cents so equal highs and equal lows happen, like real prices.
    const r = (x: number) => Math.round(x * 4) / 4;
    out.push({ time: T0 + i * 300, open: r(open), high: r(high), low: r(low), close: r(close), volume: Math.round(rnd() * 1000), vwap: null, transactions: null });
  }
  return out;
}

/** The fields of a sweep that are fixed at its sweep bar; `endIndex` and `open` can still move. */
function sweepStart(s: LiquiditySweep) {
  return { id: s.id, zoneId: s.zoneId, kind: s.kind, direction: s.direction, index: s.index, level: s.level, extreme: s.extreme, touches: s.touches, volume: s.volume };
}
function zoneStart(z: LiquidityZone) {
  return { id: z.id, side: z.side, pivotIndex: z.pivotIndex, confirmIndex: z.confirmIndex, top: z.top, bottom: z.bottom, level: z.level };
}

describe('4.8 no look-ahead', () => {
  const cases: [string, LiquidityParams][] = [
    ['wick zones, both sweeps', P({ lookback: 3, maxAge: 40, sweepExtend: 8 })],
    ['range zones, retests, minTouches 2', P({ lookback: 2, zoneMode: 'range', sweepMode: 'retests', minTouches: 2, maxAge: 25, sweepExtend: 5 })],
    ['defaults', { lookback: 10, zoneMode: 'wick', sweepMode: 'wicks', minTouches: 0, maxAge: 300, sweepExtend: 20 }],
  ];

  it.each(cases)('%s: output for bars 0..k does not change when more bars arrive', (_name, params) => {
    const all = ohlcWalk(600, 777);
    const full = computeLiquidity(all, params);
    const fullZones = new Map(full.zones.map((z) => [z.id, z]));
    const fullSweeps = new Map(full.sweeps.map((s) => [s.id, s]));
    expect(full.zones.length).toBeGreaterThan(5);
    expect(full.sweeps.length).toBeGreaterThan(2);

    for (let k = 0; k < all.length; k += 7) {
      const part = computeLiquidity(all.slice(0, k + 1), params);
      for (const z of part.zones) {
        const f = fullZones.get(z.id);
        if (z.status !== 'active') expect(f).toEqual(z); // closed: final
        else expect(f && zoneStart(f)).toEqual(zoneStart(z)); // open: same zone, may still grow
      }
      for (const s of part.sweeps) {
        const f = fullSweeps.get(s.id);
        if (!s.open) expect(f).toEqual(s);
        else expect(f && sweepStart(f)).toEqual(sweepStart(s));
      }
      // Everything the full run fixed by bar k is already in the partial run.
      const partZones = new Set(part.zones.map((z) => z.id));
      for (const f of full.zones) if (f.status !== 'active' && f.endIndex <= k && f.confirmIndex <= k) expect(partZones.has(f.id)).toBe(true);
      const partSweeps = new Set(part.sweeps.map((s) => s.id));
      for (const f of full.sweeps) if (f.index <= k) expect(partSweeps.has(f.id)).toBe(true);
    }
  });

  it('nothing in the output starts before its confirmation bar', () => {
    const r = computeLiquidity(ohlcWalk(400, 99), P({ lookback: 4, maxAge: 60 }));
    const confirm = new Map(r.zones.map((z) => [z.id, z.confirmIndex]));
    for (const z of r.zones) expect(z.confirmIndex).toBe(z.pivotIndex + 4);
    for (const s of r.sweeps) expect(s.index).toBeGreaterThan(confirm.get(s.zoneId) ?? -1);
  });
});

describe('validation and performance', () => {
  it('throws on invalid params', () => {
    expect(() => computeLiquidity(bars(HIGH_PIVOT), P({ lookback: 1 }))).toThrow(InvalidIndicatorParamsError);
  });

  it('handles 10 000 bars with a small lookback quickly', () => {
    const all = ohlcWalk(10_000, 4242);
    const t = performance.now();
    const r = computeLiquidity(all, P({ lookback: 2, maxAge: 5000, sweepExtend: 20 }));
    const ms = performance.now() - t;
    expect(r.zones.length).toBeGreaterThan(500);
    expect(ms).toBeLessThan(1000);
  });
});
