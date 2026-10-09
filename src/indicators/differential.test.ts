/**
 * DIFFERENTIAL TEST — client math (`src/indicators`) against the server's independent
 * implementation (`server/provider/indicators.ts`), over real engine bars.
 *
 * Importing the server module here is a sanctioned exception to the client/server
 * boundary, for test code only. Production code in `src/` must never import it.
 *
 * Two independent implementations agreeing rules out one author's misreading of the
 * conventions. It does not prove either correct — that is the job of the published
 * vectors in `compute.test.ts` — and both run on the same bars, so a bug in how the
 * engine produces bars is invisible here.
 *
 * TOLERANCE. Both sides do double-precision O(n) recursions, so they can differ only by
 * floating-point rounding: the server keeps a naive running sum for its SMA (one rounding
 * error per bar) and writes the EMA update as `v*k + prev*(1-k)`; this module compensates
 * the sum and writes `prev + k*(v-prev)`. Measured worst absolute difference across every
 * run in this file: 2.2e-11 (printed by the last test), on prices in the hundreds. The
 * bound is 1e-9 * max(1, |value|): ~50x above that, yet ~seven orders of magnitude below
 * the smallest convention error (a wrong EMA seed or a simple-mean RSI moves lines by
 * 1e-2..1e0), so it cannot hide a real divergence.
 * Null patterns, warmup, keys, labels and times are compared EXACTLY.
 */
import { describe, expect, it } from 'vitest';
import type { Bar, IndicatorLine, IndicatorSeries, Timeframe } from '@shared/types';
import { createSyntheticEngine } from '../../server/market';
import { computeIndicator as serverCompute } from '../../server/provider/indicators';
import type { IndicatorRequest } from '../../server/provider/indicators';
import { computeIndicator } from './compute';
import { makeBars, walk } from './fixtures';

const engine = createSyntheticEngine();
const REL_TOL = 1e-9;

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000;

function engineBars(symbol: string, timeframe: Timeframe, from: number, to: number, limit = 5000): Bar[] {
  return engine.getBars({ symbol, timeframe, from, to, adjusted: true, limit }).bars;
}

type Case = { name: string; kind: IndicatorRequest['kind']; params: Record<string, number>; req: IndicatorRequest };
const cases: Case[] = [
  ...[1, 2, 5, 14, 20, 50, 200, 500].flatMap((period): Case[] =>
    (['sma', 'ema', 'rsi', 'volume'] as const).map((kind) => ({ name: `${kind}(${period})`, kind, params: { period }, req: { kind, period } })),
  ),
  ...(
    [
      [12, 26, 9],
      [5, 35, 5],
      [1, 2, 1],
      [3, 8, 3],
      [2, 3, 1],
      [20, 100, 30],
      [100, 500, 50],
    ] as const
  ).map(
    ([fastPeriod, slowPeriod, signalPeriod]): Case => ({
      name: `macd(${fastPeriod},${slowPeriod},${signalPeriod})`,
      kind: 'macd',
      params: { fastPeriod, slowPeriod, signalPeriod },
      req: { kind: 'macd', fastPeriod, slowPeriod, signalPeriod },
    }),
  ),
];

/** Largest absolute difference seen, for the record; reported by the final test. */
let worst = 0;

function expectAgree(ours: IndicatorSeries, theirs: IndicatorSeries, label: string): void {
  expect(ours.kind, label).toBe(theirs.kind);
  expect(ours.placement, label).toBe(theirs.placement);
  expect(ours.params, label).toEqual(theirs.params);
  expect(ours.warmup, `${label} warmup`).toBe(theirs.warmup);
  expect(ours.lines.map((l) => [l.key, l.label]), label).toEqual(theirs.lines.map((l) => [l.key, l.label]));
  ours.lines.forEach((line: IndicatorLine, li) => {
    const other = theirs.lines[li] as IndicatorLine;
    expect(line.points.length, `${label}/${line.key} length`).toBe(other.points.length);
    for (let i = 0; i < line.points.length; i++) {
      const a = line.points[i];
      const b = other.points[i];
      if (a === undefined || b === undefined) throw new Error('unreachable: lengths checked');
      if (a.time !== b.time) throw new Error(`${label}/${line.key}[${i}] time ${a.time} != ${b.time}`);
      if ((a.value === null) !== (b.value === null)) {
        throw new Error(`${label}/${line.key}[${i}] null mismatch: ours=${String(a.value)} server=${String(b.value)}`);
      }
      if (a.value !== null && b.value !== null) {
        const diff = Math.abs(a.value - b.value);
        worst = Math.max(worst, diff);
        if (diff > REL_TOL * Math.max(1, Math.abs(a.value), Math.abs(b.value))) {
          throw new Error(`${label}/${line.key}[${i}] ours=${a.value} server=${b.value} diff=${diff}`);
        }
      }
    }
  });
}

describe('differential: client indicators vs server implementation', () => {
  const symbols = engine
    .listSymbols()
    .map((s) => s.symbol)
    .filter((_, i) => i % 3 === 0)
    .slice(0, 6);
  const datasets: [string, Bar[]][] = [];
  for (const symbol of symbols) {
    datasets.push([`${symbol} 1D`, engineBars(symbol, '1D', utc(2012, 1, 1), utc(2026, 9, 1))]);
    datasets.push([`${symbol} 1h`, engineBars(symbol, '1h', utc(2024, 1, 1), utc(2026, 9, 1))]);
  }
  datasets.push(['AAPL 5m', engineBars('AAPL', '5m', utc(2026, 1, 1), utc(2026, 9, 1))]);
  datasets.push(['MSFT 1W', engineBars('MSFT', '1W', utc(2000, 1, 1), utc(2026, 9, 1))]);

  it('uses a meaningful amount of real data', () => {
    expect(datasets.length).toBeGreaterThanOrEqual(8);
    for (const [name, bars] of datasets) expect(bars.length, name).toBeGreaterThan(300);
    expect(Math.max(...datasets.map(([, b]) => b.length))).toBeGreaterThanOrEqual(2000);
  });

  describe.each(datasets)('%s', (_name, bars) => {
    it.each(cases)('$name agrees', (c) => {
      expectAgree(computeIndicator(bars, c.kind, c.params as never), serverCompute(bars, c.req), `${_name} ${c.name}`);
    });
  });

  describe('edge cases on synthetic series', () => {
    const lengths = [0, 1, 2, 4, 5, 6, 13, 14, 15, 25, 26, 27, 34, 35, 36, 60];
    const series: [string, number[]][] = [
      ['flat', Array<number>(60).fill(42.5)],
      ['rising', Array.from({ length: 60 }, (_, i) => 10 + i)],
      ['falling', Array.from({ length: 60 }, (_, i) => 100 - i)],
      ['rally then one drop', [100, 99, ...Array.from({ length: 58 }, (_, i) => 99 + (i + 1) * 0.5)]],
      ['walk', walk(60, 77)],
    ];
    for (const [name, closes] of series) {
      it.each(lengths)(`${name}, first %i bars: every case agrees`, (n) => {
        const bars = makeBars(closes.slice(0, n));
        for (const c of cases) expectAgree(computeIndicator(bars, c.kind, c.params as never), serverCompute(bars, c.req), `${name}[${n}] ${c.name}`);
      });
    }
  });

  it('reports the largest disagreement observed', () => {
    // Not an assertion on its own value beyond the tolerance; surfaced so the number is on record.
    console.log(`differential: worst absolute difference across all runs = ${worst.toExponential(3)}`);
    expect(worst).toBeLessThan(1e-7);
  });
});
