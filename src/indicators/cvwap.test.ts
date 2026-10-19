import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { computeCvwap } from './cvwap';

const bar = (i: number, over: Partial<Bar> = {}): Bar => ({
  time: 1_700_000_000 + i * 60,
  open: 10,
  high: 12,
  low: 8,
  close: 10,
  volume: 100,
  vwap: null,
  transactions: null,
  ...over,
});

describe('computeCvwap', () => {
  it('anchors the VWAP of hlc3 on the first bar of the window', () => {
    // hlc3: 10, then 20; volumes 100 and 300.
    const bars = [bar(0, { high: 100, low: 0, close: 0 }), bar(1), bar(2, { high: 21, low: 19, close: 20, volume: 300 })];
    const r = computeCvwap(bars, 1, 2, 0);
    expect(r?.from).toBe(1);
    expect(r?.vwap).toEqual([10, (10 * 100 + 20 * 300) / 400]);
  });

  it('draws bands at bandMult volume-weighted standard deviations', () => {
    // hlc3 10 and 20 with equal volume: VWAP 15, standard deviation 5.
    const bars = [bar(0), bar(1, { high: 21, low: 19, close: 20 })];
    const r = computeCvwap(bars, 0, 1, 2);
    expect(r?.vwap[1]).toBeCloseTo(15);
    expect(r?.upper[1]).toBeCloseTo(25);
    expect(r?.lower[1]).toBeCloseTo(5);
    // The first bar alone has no spread.
    expect(r?.upper[0]).toBeCloseTo(10);
  });

  it('gives the bands the VWAP value when bandMult is 0, and never NaN on a flat window', () => {
    const flat = Array.from({ length: 5 }, (_, i) => bar(i, { open: 1.1, high: 1.1, low: 1.1, close: 1.1 }));
    const r = computeCvwap(flat, 0, 4, 3);
    for (const v of [...(r?.upper ?? []), ...(r?.lower ?? [])]) expect(v).toBeCloseTo(1.1);
    expect(computeCvwap([bar(0), bar(1, { close: 11 })], 0, 1, 0)?.upper).toEqual(computeCvwap([bar(0), bar(1, { close: 11 })], 0, 1, 0)?.vwap);
  });

  it('returns null VWAP points until the window has volume', () => {
    const bars = [bar(0, { volume: 0 }), bar(1, { volume: Number.NaN }), bar(2)];
    const r = computeCvwap(bars, 0, 2, 1);
    expect(r?.vwap).toEqual([null, null, 10]);
    expect(r?.upper[0]).toBeNull();
    expect(r?.lower[1]).toBeNull();
  });

  it('gives the mean close and the open, high, low and close of the window', () => {
    const bars = [bar(0, { open: 9, close: 11, high: 15 }), bar(1, { close: 13, low: 2 }), bar(2, { close: 12 })];
    const r = computeCvwap(bars, 0, 2, 0);
    expect(r?.average).toBeCloseTo(12);
    expect(r).toMatchObject({ open: 9, high: 15, low: 2, close: 12 });
  });

  it('clamps the window to the bars and returns null for an empty window', () => {
    const bars = [bar(0), bar(1)];
    expect(computeCvwap(bars, -5, 10, 0)).toMatchObject({ from: 0, to: 1 });
    expect(computeCvwap(bars, 3, 4, 0)).toBeNull();
    expect(computeCvwap([], 0, 0, 0)).toBeNull();
  });
});
