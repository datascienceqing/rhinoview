import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { computeIndicator } from './indicators';

const bars = (closes: number[]): Bar[] =>
  closes.map((close, i) => ({ time: 1_000 + i * 60, open: close, high: close, low: close, close, volume: 1, vwap: null, transactions: null }));

const values = (s: ReturnType<typeof computeIndicator>, key = 'value') => (s.lines.find((l) => l.key === key)?.points ?? []).map((p) => p.value);

describe('computeIndicator', () => {
  it('SMA is null through warmup (never 0), then the rolling mean', () => {
    const s = computeIndicator(bars([1, 2, 3, 4, 5, 6]), { kind: 'sma', period: 3 });
    expect(values(s)).toEqual([null, null, 2, 3, 4, 5]);
    expect(s.warmup).toBe(2);
  });

  it('EMA is seeded with the SMA, then k = 2/(n+1)', () => {
    const s = computeIndicator(bars([1, 2, 3, 4, 5, 6]), { kind: 'ema', period: 3 });
    expect(values(s)).toEqual([null, null, 2, 3, 4, 5]);
    expect(s.warmup).toBe(2);
  });

  it("RSI matches the textbook 14-period worked example (Wilder smoothing)", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41,
      46.22, 45.64,
    ];
    const s = computeIndicator(bars(closes), { kind: 'rsi', period: 14 });
    const v = values(s);
    expect(v.slice(0, 14).every((x) => x === null)).toBe(true);
    expect(s.warmup).toBe(14);
    // By hand: first 14 changes sum to gains 3.34 and losses 1.40, so
    // RSI = 100 - 100 / (1 + 3.34 / 1.40) = 70.4641...
    expect(v[14]).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 6);
    // The widely printed table (StockCharts) rounds intermediates and so differs in the
    // second decimal (70.53, 66.32, 66.55, 69.41, 66.36, 57.97); stay within 0.1 of it.
    [70.53, 66.32, 66.55, 69.41, 66.36, 57.97].forEach((published, i) => {
      expect(Math.abs((v[14 + i] ?? NaN) - published)).toBeLessThan(0.1);
    });
  });

  it('RSI is 100 for a monotonic rise and 50 for a flat series', () => {
    expect(values(computeIndicator(bars([1, 2, 3, 4, 5, 6]), { kind: 'rsi', period: 3 })).at(-1)).toBe(100);
    expect(values(computeIndicator(bars([5, 5, 5, 5, 5, 5]), { kind: 'rsi', period: 3 })).at(-1)).toBe(50);
  });

  it('MACD = EMA(fast) - EMA(slow); signal/histogram start later; keys in contract order', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + Math.sin(i / 2) * 3 + i * 0.2);
    const m = computeIndicator(bars(closes), { kind: 'macd', fastPeriod: 3, slowPeriod: 6, signalPeriod: 3 });
    const fast = values(computeIndicator(bars(closes), { kind: 'ema', period: 3 }));
    const slow = values(computeIndicator(bars(closes), { kind: 'ema', period: 6 }));
    const macd = values(m, 'macd');
    const signal = values(m, 'signal');
    const hist = values(m, 'histogram');

    expect(m.lines.map((l) => l.key)).toEqual(['macd', 'signal', 'histogram']);
    expect(m.warmup).toBe(5); // slowPeriod - 1
    expect(macd.slice(0, 5).every((x) => x === null)).toBe(true);
    expect(signal.slice(0, 7).every((x) => x === null)).toBe(true); // slow-1 + signal-1 = 7
    expect(signal[7]).not.toBeNull();
    for (let i = 5; i < closes.length; i++) {
      expect(macd[i]).toBeCloseTo((fast[i] ?? NaN) - (slow[i] ?? NaN), 10);
    }
    for (let i = 7; i < closes.length; i++) {
      expect(hist[i]).toBeCloseTo((macd[i] ?? NaN) - (signal[i] ?? NaN), 10);
    }
  });

  it('MACD of a constant series is zero once defined', () => {
    const m = computeIndicator(bars(Array<number>(30).fill(7)), { kind: 'macd', fastPeriod: 3, slowPeriod: 6, signalPeriod: 3 });
    expect(values(m, 'histogram').at(-1)).toBeCloseTo(0, 12);
  });

  it('handles fewer bars than the warmup: all null, warmup = bar count', () => {
    const s = computeIndicator(bars([1, 2]), { kind: 'sma', period: 5 });
    expect(values(s)).toEqual([null, null]);
    expect(s.warmup).toBe(2);
  });

  it('handles no bars', () => {
    const s = computeIndicator([], { kind: 'rsi', period: 14 });
    expect(s.lines[0]?.points).toEqual([]);
    expect(s.warmup).toBe(0);
  });

  it('points carry the bar times in seconds', () => {
    const s = computeIndicator(bars([1, 2, 3]), { kind: 'sma', period: 1 });
    expect(s.lines[0]?.points.map((p) => p.time)).toEqual([1_000, 1_060, 1_120]);
  });
});
