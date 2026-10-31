import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { randomBars } from '../../../src/indicators/fixtures';
import { adx, bollinger, columns, last, monthlyFromWeekly, rating, ratingLabel, volumeRatio, volumeSignals } from './ta';
import { atr } from '../../../src/indicators/math';

const bar = (time: number, close: number, over: Partial<Bar> = {}): Bar => ({
  time, open: close, high: close + 1, low: close - 1, close, volume: 1000, vwap: null, transactions: null, ...over,
});

describe('adx', () => {
  it('has no value before 2 × period bars', () => {
    const c = columns(randomBars(40, 1));
    const { adx: a } = adx(c.high, c.low, c.close, 14);
    expect(Number.isNaN(a[26] as number)).toBe(true);
    expect(Number.isFinite(a[27] as number)).toBe(true);
  });

  it('is high with +DI over −DI in a steady rise', () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i * 2));
    const c = columns(bars);
    const d = adx(c.high, c.low, c.close, 14);
    expect(last(d.adx)).toBeGreaterThan(50);
    expect(last(d.plusDi)).toBeGreaterThan(last(d.minusDi) as number);
  });
});

describe('bollinger', () => {
  it('collapses to the mean on a flat series', () => {
    const b = bollinger(Float64Array.from({ length: 30 }, () => 50), 20, 2);
    expect(last(b.upper)).toBe(50);
    expect(last(b.lower)).toBe(50);
  });

  it('uses the population standard deviation', () => {
    // 1..20: mean 10.5, population sd = sqrt((20² − 1) / 12).
    const b = bollinger(Float64Array.from({ length: 20 }, (_, i) => i + 1), 20, 2);
    expect(last(b.upper)).toBeCloseTo(10.5 + 2 * Math.sqrt(399 / 12), 10);
  });
});

describe('rating', () => {
  it('uses the skill bands for the label', () => {
    expect(ratingLabel(-0.09)).toBe('Neutral');
    expect(ratingLabel(-0.34)).toBe('Sell');
    expect(ratingLabel(0.27)).toBe('Buy');
    expect(ratingLabel(0.6)).toBe('Strong Buy');
    expect(ratingLabel(-0.6)).toBe('Strong Sell');
  });

  it('is a buy in a steady rise and a sell in a steady fall', () => {
    const up = Array.from({ length: 250 }, (_, i) => bar(i, 100 + i));
    const down = Array.from({ length: 250 }, (_, i) => bar(i, 400 - i));
    expect((rating(up)?.score ?? 0) > 0.1).toBe(true);
    expect((rating(down)?.score ?? 0) < -0.1).toBe(true);
  });

  it('is null with too few bars for any MA', () => {
    expect(rating([bar(0, 1), bar(1, 2)])).toBeNull();
  });
});

describe('monthlyFromWeekly', () => {
  it('folds the weeks of one month into one bar', () => {
    const jan5 = Date.UTC(2026, 0, 5) / 1000;
    const week = 7 * 86_400;
    const weeks = [0, 1, 2, 3, 4].map((k) => bar(jan5 + k * week, 10 + k, { high: 20 + k, low: 5 - k, volume: 100 }));
    const months = monthlyFromWeekly(weeks);
    expect(months).toHaveLength(2); // Jan 5, 12, 19, 26 | Feb 2
    expect(months[0]).toMatchObject({ open: 10, close: 13, high: 23, low: 2, volume: 400 });
  });
});

describe('volume', () => {
  it('divides by the mean of the bars before, not including the bar', () => {
    const r = volumeRatio(Float64Array.from([10, 10, 10, 30]), 3);
    expect(r[3]).toBe(3);
    expect(Number.isNaN(r[2] as number)).toBe(true);
  });

  it('finds a capitulation bar and a dry-up', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100));
    bars[35] = bar(35, 90, { high: 100, low: 80, volume: 5000 });
    const c = columns(bars);
    const s = volumeSignals(bars, atr(c.high, c.low, c.close, 14));
    expect(s.capitulation?.index).toBe(35);

    const quiet = Array.from({ length: 40 }, (_, i) => bar(i, 100, { volume: i >= 37 ? 300 : 1000 }));
    const q = columns(quiet);
    expect(volumeSignals(quiet, atr(q.high, q.low, q.close, 14)).dryUp).toBe(true);
  });
});
