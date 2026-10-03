/** Test helpers shared by the indicator test files. Not part of the module's public surface. */
import type { Bar, IndicatorSeries } from '@shared/types';

export function makeBars(closes: readonly number[], t0 = 1_700_000_000, step = 300): Bar[] {
  return closes.map((close, i) => ({
    time: t0 + i * step,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000 + i,
    vwap: null,
    transactions: null,
  }));
}

export function lineValues(series: IndicatorSeries, key = 'value'): (number | null)[] {
  const line = series.lines.find((l) => l.key === key);
  if (!line) throw new Error(`no line '${key}' in ${series.kind}`);
  return line.points.map((p) => p.value);
}

/** Deterministic pseudo-random walk (LCG), so property tests never depend on Math.random. */
export function walk(n: number, seed = 12345, start = 100): number[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = Math.max(1, p + (next() - 0.5) * 2);
    out.push(p);
  }
  return out;
}
