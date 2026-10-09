/**
 * The first seven tests are ported from Vela (github.com/datascienceqing/Vela, Apache-2.0),
 * `test/vpvr-profile.test.ts`, with this app's `Bar` in place of Vela's OHLCV. The rest
 * are new.
 */
import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { buildVpvrProfile } from './vpvr';

function bar(low: number, high: number, volume: number, up = true, time = 0): Bar {
  const open = up ? low : high;
  const close = up ? high : low;
  return { time, open, high, low, close, volume, vwap: null, transactions: null };
}
const at = (price: number, volume: number, time = 0): Bar => ({
  time,
  open: price,
  high: price,
  low: price,
  close: price,
  volume,
  vwap: null,
  transactions: null,
});
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

describe('buildVpvrProfile', () => {
  it('conserves total volume exactly across the rows', () => {
    const p = buildVpvrProfile([bar(100, 110, 500), bar(103, 118, 750, false), bar(95, 105, 250)], 0, 2, 24, 0.7);
    expect(sum(p?.rows.map((r) => r.up + r.down) ?? [])).toBeCloseTo(1500, 6);
  });

  it('splits up and down volume by bar direction', () => {
    const p = buildVpvrProfile([bar(100, 110, 600, true), bar(100, 110, 600, false)], 0, 1, 10, 0.7);
    for (const r of p?.rows ?? []) expect(r.up).toBeCloseTo(r.down, 6);
    expect(sum(p?.rows.map((r) => r.up) ?? [])).toBeCloseTo(600, 6);
  });

  it('puts the POC where the most volume overlaps', () => {
    // The two bars overlap only in [104, 106]: those rows carry double volume.
    const p = buildVpvrProfile([bar(100, 106, 600), bar(104, 110, 600)], 0, 1, 10, 0.7);
    if (!p) throw new Error('no profile');
    expect(p.rowH).toBeCloseTo(1, 6);
    const pocPrice = p.rows[p.poc]?.price ?? NaN;
    expect(pocPrice).toBeGreaterThanOrEqual(104 - 1e-9);
    expect(pocPrice + p.rowH).toBeLessThanOrEqual(106 + 1e-9);
  });

  it('grows the value area around the POC to cover the requested volume fraction', () => {
    const bars = [bar(100, 106, 600), bar(104, 110, 600)];
    const p = buildVpvrProfile(bars, 0, 1, 10, 0.7);
    if (!p) throw new Error('no profile');
    const total = sum(p.rows.map((r) => r.up + r.down));
    const va = sum(p.rows.slice(p.vaFrom, p.vaTo + 1).map((r) => r.up + r.down));
    expect(va).toBeGreaterThanOrEqual(total * 0.7 - 1e-6);
    expect(p.vaFrom).toBeLessThanOrEqual(p.poc);
    expect(p.vaTo).toBeGreaterThanOrEqual(p.poc);
    const full = buildVpvrProfile(bars, 0, 1, 10, 1);
    expect([full?.vaFrom, full?.vaTo]).toEqual([0, (full?.rows.length ?? 0) - 1]);
    const none = buildVpvrProfile(bars, 0, 1, 10, 0);
    expect([none?.vaFrom, none?.vaTo]).toEqual([none?.poc, none?.poc]);
  });

  it('gives a flat (zero-range) window one row, and skips bars with no volume', () => {
    const noVol = { ...bar(80, 120, 0, false), time: 1 };
    const p = buildVpvrProfile([at(100, 400), noVol], 0, 1, 24, 0.7);
    expect(p?.rows).toHaveLength(1);
    expect(p?.rows[0]?.up).toBeCloseTo(400, 6);
    expect(p?.maxTotal).toBeCloseTo(400, 6);
  });

  it('returns null when the window holds no volume or no bars', () => {
    expect(buildVpvrProfile([bar(80, 120, 0)], 0, 0, 24, 0.7)).toBeNull();
    expect(buildVpvrProfile([], 0, 0, 24, 0.7)).toBeNull();
    expect(buildVpvrProfile([bar(100, 110, 100)], 5, 9, 24, 0.7)).toBeNull(); // window past the array
  });

  it('puts all the volume of a point bar (high == low) in the row that holds its price', () => {
    const p = buildVpvrProfile([bar(100, 110, 1000), at(105, 5000, 1)], 0, 1, 10, 0.7);
    if (!p) throw new Error('no profile');
    const k = p.rows.findIndex((r) => 105 >= r.price && 105 < r.price + p.rowH);
    expect(p.poc).toBe(k);
    expect(p.rows[k]?.up).toBeGreaterThanOrEqual(5000);
  });

  // ── new ──

  it('uses only the bars inside the window [i0, i1]', () => {
    const bars = [bar(10, 20, 1_000_000), bar(100, 110, 500), bar(100, 110, 500)];
    const p = buildVpvrProfile(bars, 1, 2, 10, 0.7);
    expect(p?.min).toBe(100);
    expect(sum(p?.rows.map((r) => r.up + r.down) ?? [])).toBeCloseTo(1000, 6);
  });

  it('clamps a window that starts before 0 or ends past the last bar', () => {
    const bars = [bar(100, 110, 500), bar(100, 110, 500)];
    expect(buildVpvrProfile(bars, -5, 50, 10, 0.7)).toEqual(buildVpvrProfile(bars, 0, 1, 10, 0.7));
  });

  it('makes exactly `rowCount` rows that tile the window from low to high', () => {
    const p = buildVpvrProfile([bar(100, 112, 10), bar(103, 124, 10)], 0, 1, 24, 0.7);
    if (!p) throw new Error('no profile');
    expect(p.rows).toHaveLength(24);
    expect(p.rows[0]?.price).toBe(100);
    expect((p.rows.at(-1)?.price ?? 0) + p.rowH).toBeCloseTo(124, 9);
  });

  it('treats a non-finite volume like no volume', () => {
    const p = buildVpvrProfile([bar(0, 1000, Number.NaN), bar(100, 110, 50)], 0, 1, 10, 0.7);
    expect(p?.min).toBe(100);
  });
});
