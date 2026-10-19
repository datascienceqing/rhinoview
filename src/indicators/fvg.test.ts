import { describe, expect, it } from 'vitest';
import type { Bar, FvgParams } from '@shared/types';
import { computeFvg } from './fvg';
import type { FvgZone } from './fvg';
import { checkIndicatorParams } from './params';
import { DEFAULT_PARAMS, InvalidIndicatorParamsError } from './types';

// Bars from [open, high, low, close] rows. Time = index * 1 day.
type Row = [number, number, number, number];
const T0 = 1_700_000_000;
function bars(rows: readonly Row[]): Bar[] {
  return rows.map(([open, high, low, close], i) => ({
    time: T0 + i * 86_400,
    open,
    high,
    low,
    close,
    volume: 100,
    vwap: null,
    transactions: null,
  }));
}

/** A quiet bar near 100. Its true range is 2, so the ATR of quiet bars is 2. */
const Q: Row = [100, 101, 99, 100];
/** 20 quiet bars: the ATR(14) has a value from bar 13. */
const WARM: Row[] = Array.from({ length: 20 }, () => Q);

const P = (over: Partial<FvgParams> = {}): FvgParams => ({ ...DEFAULT_PARAMS.fvg, ...over });

const only = (zones: readonly FvgZone[]): FvgZone => {
  expect(zones).toHaveLength(1);
  return zones[0] as FvgZone;
};

/** Bars 20-22 make a bullish gap 101..104: bar 20 high 101, bar 22 low 104. */
const BULL: Row[] = [...WARM, [100, 101, 99, 100.5], [101, 107, 100.5, 106], [106, 108, 104, 107]];
/** Bars 20-22 make a bearish gap 96..99: bar 20 low 99, bar 22 high 96. */
const BEAR: Row[] = [...WARM, [100, 101, 99, 99.5], [99, 99.5, 93, 94], [94, 96, 92, 93]];

describe('computeFvg', () => {
  it('finds a bullish gap between the wick of bar 1 and bar 3, from the middle bar', () => {
    const z = only(computeFvg(bars(BULL), P()).zones);
    expect(z).toMatchObject({ side: 'bull', startIndex: 21, createIndex: 22, endIndex: 22, top: 104, bottom: 101 });
    expect(z.touchIndex).toBeNull();
    expect(z.fillIndex).toBeNull();
  });

  it('finds a bearish gap', () => {
    const z = only(computeFvg(bars(BEAR), P()).zones);
    expect(z).toMatchObject({ side: 'bear', startIndex: 21, createIndex: 22, top: 99, bottom: 96 });
  });

  it('finds no gap when the wicks touch', () => {
    const rows: Row[] = [...WARM, [100, 101, 99, 100.5], [101, 107, 100.5, 106], [106, 108, 101, 107]];
    expect(computeFvg(bars(rows), P()).zones).toEqual([]);
  });

  it('finds no gap before the ATR has a value, like the Pine script', () => {
    const early = BULL.slice(20);
    expect(computeFvg(bars(early), P()).zones).toEqual([]);
    expect(computeFvg([], P()).zones).toEqual([]);
  });

  it('does not mitigate a gap on the bar that makes it', () => {
    // The gap bar's low is the top of the zone. The script marked it as entered here.
    const z = only(computeFvg(bars(BULL), P({ mitigation: 'wick' })).zones);
    expect(z.touchIndex).toBeNull();
  });

  it('mode wick: the first later bar whose range reaches the zone mitigates it', () => {
    const rows: Row[] = [...BULL, [107, 109, 105, 108], [108, 108.5, 103.5, 105], [105, 106, 102, 103]];
    const z = only(computeFvg(bars(rows), P({ mitigation: 'wick' })).zones);
    expect(z.touchIndex).toBe(24);
    expect(z.fillIndex).toBeNull();
  });

  it('mode fill: only a close inside the zone mitigates it', () => {
    const rows: Row[] = [...BULL, [107, 109, 105, 108], [108, 108.5, 103.5, 105], [105, 106, 102, 103]];
    const z = only(computeFvg(bars(rows), P({ mitigation: 'fill' })).zones);
    expect(z.touchIndex).toBe(25);
  });

  it('marks a gap filled at the first close past its far edge, and then stops the checks', () => {
    const rows: Row[] = [...BULL, [107, 107, 100, 100.5], [100, 105, 99, 104]];
    const z = only(computeFvg(bars(rows), P()).zones);
    expect(z.touchIndex).toBe(23);
    expect(z.fillIndex).toBe(23);

    const bear = only(computeFvg(bars([...BEAR, [93, 100, 93, 99.5]]), P()).zones);
    expect(bear.fillIndex).toBe(23);
  });

  it('style remove hides mitigated gaps', () => {
    const rows: Row[] = [...BULL, [107, 107, 103, 106]];
    expect(computeFvg(bars(rows), P({ mitigatedStyle: 'dim' })).zones).toHaveLength(1);
    expect(computeFvg(bars(rows), P({ mitigatedStyle: 'remove' })).zones).toEqual([]);
  });

  it('extends a box to the last bar, or gives it a fixed length from the middle bar', () => {
    const rows: Row[] = [...BULL, [107, 109, 105, 108], [108, 109, 105, 108]];
    expect(only(computeFvg(bars(rows), P({ extend: 'right' })).zones).endIndex).toBe(24);
    expect(only(computeFvg(bars(rows), P({ extend: 'fixed', boxLength: 50 })).zones).endIndex).toBe(71);
  });

  it('applies the minimum gap filter in percent of the ATR', () => {
    // The gap is 3 and the ATR at bar 22 is about 2.4, so the gap is about 125 % of the ATR.
    expect(computeFvg(bars(BULL), P({ minGapAtrPct: 100 })).zones).toHaveLength(1);
    expect(computeFvg(bars(BULL), P({ minGapAtrPct: 200 })).zones).toEqual([]);
  });

  it('applies the displacement filter to the body of the middle bar', () => {
    // The middle body is 5, about 2 ATR.
    expect(computeFvg(bars(BULL), P({ displacementAtrPct: 150 })).zones).toHaveLength(1);
    expect(computeFvg(bars(BULL), P({ displacementAtrPct: 300 })).zones).toEqual([]);
  });

  it('keeps only the newest maxZones gaps', () => {
    // A staircase: each bar is 5 above the previous one, so every bar from 22 on makes a gap.
    const rows: Row[] = [...WARM];
    for (let k = 1; k <= 10; k++) {
      const base = 100 + 5 * k;
      rows.push([base - 1, base + 1, base - 1, base + 1]);
    }
    const all = computeFvg(bars(rows), P({ maxZones: 500 })).zones;
    expect(all.length).toBeGreaterThan(3);
    const kept = computeFvg(bars(rows), P({ maxZones: 3 })).zones;
    expect(kept.map((z) => z.id)).toEqual(all.slice(-3).map((z) => z.id));
  });

  it('does not look ahead: a gap and its state at bar k do not change when later bars arrive', () => {
    const rows: Row[] = [...BULL, [107, 109, 105, 108], [108, 108.5, 103.5, 105], [105, 106, 102, 103], [103, 104, 100, 100.5]];
    const full = computeFvg(bars(rows), P({ extend: 'fixed' })).zones;
    for (let cut = 23; cut <= rows.length; cut++) {
      const part = computeFvg(bars(rows.slice(0, cut)), P({ extend: 'fixed' })).zones;
      for (const z of part) {
        const later = full.find((f) => f.id === z.id);
        expect(later).toBeDefined();
        if (z.touchIndex !== null) expect(later?.touchIndex).toBe(z.touchIndex);
        if (z.fillIndex !== null) expect(later?.fillIndex).toBe(z.fillIndex);
      }
    }
  });

  it('throws on invalid params', () => {
    expect(() => computeFvg(bars(BULL), P({ maxZones: 0 }))).toThrow(InvalidIndicatorParamsError);
  });
});

describe('checkIndicatorParams fvg', () => {
  it('accepts the defaults', () => {
    expect(checkIndicatorParams('fvg', DEFAULT_PARAMS.fvg)).toBeNull();
  });

  it.each([
    [{ minGapAtrPct: -0.1 }, /minGapAtrPct/],
    [{ displacementAtrPct: Number.NaN }, /displacementAtrPct/],
    [{ maxZones: 1.5 }, /maxZones/],
    [{ boxLength: 501 }, /boxLength/],
    [{ extend: 'left' }, /extend/],
    [{ labels: true }, /labels/],
    [{ mitigation: 'close' }, /mitigation/],
    [{ mitigatedStyle: 'hide' }, /mitigatedStyle/],
  ])('rejects %o', (over, message) => {
    expect(checkIndicatorParams('fvg', { ...DEFAULT_PARAMS.fvg, ...over } as unknown as FvgParams)).toMatch(message);
  });
});
