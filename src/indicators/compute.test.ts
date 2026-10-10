import { describe, expect, it } from 'vitest';
import type { Bar, IndicatorKind, IndicatorParams } from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';
import { computeIndicator } from './compute';
import { checkIndicatorParams } from './params';
import { DEFAULT_PARAMS, InvalidIndicatorParamsError, LINE_KEYS, PERIOD_MAX } from './types';
import { lineValues, makeBars, walk } from './fixtures';

/** Round half away from zero to 2 decimals, the way the published tables print. */
const r2 = (x: number): number => Math.round(x * 100) / 100;

// ───────────────────────── Published reference vectors ─────────────────────────
//
// SOURCE A — StockCharts ChartSchool, "Relative Strength Index (RSI)", the 14-period
// worked example that reproduces Wilder's method (New Concepts in Technical Trading
// Systems, 1978). Closes below are the spreadsheet's own 4-decimal values (cs-rsi.xls,
// as exported in bukosabino/ta test/data/cs-rsi.csv — the Close column only; that file's
// RSI column is NOT used because it is a re-computed variant, not the published one).
// The printed RSI column is the 2-decimal table, identical in every independent
// reproduction found (e.g. JeffreyHyer/grandmaster lib/tests/rsi.test.js).
//
// ROUNDING CONVENTION. The "70.46 vs 70.53" discrepancy people notice is INPUT rounding,
// not Wilder-vs-other smoothing: on the 4-decimal closes the first RSI is 70.53 (the
// published table); on the same closes rounded to 2 decimals it is 70.46 (the fixture in
// anandanand84/technicalindicators test/oscillators/RSI.js, SOURCE B). Both are exact
// Wilder smoothing; we assert both, each against its own inputs.
//
// NOT SOURCED: Wilder's own printed table from the 1978 book. I could not locate a
// trustworthy text reproduction of it, so nothing below claims to be that table.
const SC_CLOSES_4DP = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
  46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
  43.1314,
];
// Printed values, 2 decimals, first at index 14 (= period).
const SC_RSI_PUBLISHED = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77,
];
// SOURCE B — same series with closes rounded to 2 decimals, and the RSI it yields.
const SC_CLOSES_2DP = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21,
  46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];
const TI_RSI_2DP = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.9, 45.5, 37.32, 33.09, 37.79];

// SOURCE C — StockCharts ChartSchool, "Moving Averages — Simple and Exponential",
// 10-day SMA and EMA of the Intel closes (cs-movavg.xls). The page states the EMA "starts
// with the SMA value (22.22) for its first EMA value", i.e. convention 2. Closes and the
// printed 2-decimal SMA/EMA columns, taken from cinar/indicator trend/sma_test.go and
// trend/ema_test.go (both cite that page and compare at 2 decimals); the first three EMA
// values 22.221 / 22.208 / 22.241 also appear unrounded in juliencrn/trend-trading-bot
// ta/src/ema.rs. ganshane/shakey EMATest.scala (commented table) agrees on every EMA
// value except idx 13 (23.54 there, 23.53 in cinar); I use cinar's list throughout so the
// whole column comes from one place. SMA idx 8 and 17 are exact ties (22.905, 23.505), so
// both columns are compared with a half-cent tolerance, not 2-decimal equality.
const INTEL = [
  22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38, 22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63, 23.82,
  23.87, 23.65, 23.19, 23.1, 23.33, 22.68, 23.1, 22.4, 22.17,
];
const INTEL_SMA10 = [22.22, 22.21, 22.23, 22.26, 22.3, 22.42, 22.61, 22.77, 22.9, 23.08, 23.21, 23.38, 23.53, 23.65, 23.71, 23.68, 23.61, 23.51, 23.43, 23.28, 23.13];
const INTEL_EMA10 = [22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.8, 22.97, 23.13, 23.28, 23.34, 23.43, 23.51, 23.53, 23.47, 23.4, 23.39, 23.26, 23.23, 23.08, 22.92];

describe('published reference vectors', () => {
  it('RSI(14) on the StockCharts/Wilder closes reproduces the published table to 2 decimals', () => {
    const s = computeIndicator(makeBars(SC_CLOSES_4DP), 'rsi', { period: 14 });
    const v = lineValues(s);
    expect(s.warmup).toBe(14);
    expect(v.slice(0, 14).every((x) => x === null)).toBe(true);
    expect(v.slice(14).map((x) => r2(x ?? NaN))).toEqual(SC_RSI_PUBLISHED);
  });

  it('RSI(14) on the same closes rounded to 2 decimals gives 70.46 first, as in the second reference', () => {
    const v = lineValues(computeIndicator(makeBars(SC_CLOSES_2DP), 'rsi', { period: 14 })).slice(14);
    expect(v.map((x) => r2(x ?? NaN))).toEqual(TI_RSI_2DP);
    expect(r2(v[0] ?? NaN)).toBe(70.46);
  });

  it('RSI first value follows from the printed first-window sums (hand check of the seed)', () => {
    // Gains over the first 14 changes sum to 3.3374 and losses to 1.3943 on the 4dp closes.
    const rs = 3.3374 / 1.3943;
    const v = lineValues(computeIndicator(makeBars(SC_CLOSES_4DP), 'rsi', { period: 14 }));
    expect(v[14]).toBeCloseTo(100 - 100 / (1 + rs), 3);
  });

  it('SMA(10) of the Intel closes matches the published column', () => {
    const v = lineValues(computeIndicator(makeBars(INTEL), 'sma', { period: 10 }));
    expect(v.slice(0, 9).every((x) => x === null)).toBe(true);
    const defined = v.slice(9);
    expect(defined).toHaveLength(INTEL_SMA10.length);
    defined.forEach((x, i) => expect(Math.abs((x ?? NaN) - (INTEL_SMA10[i] ?? NaN))).toBeLessThan(0.0051));
  });

  it('EMA(10) of the Intel closes, seeded with the SMA, matches the published column', () => {
    const s = computeIndicator(makeBars(INTEL), 'ema', { period: 10 });
    const v = lineValues(s);
    expect(s.warmup).toBe(9);
    expect(v[9]).toBeCloseTo(22.221, 10); // the SMA seed, unrounded: 222.21 / 10
    expect(v[10]).toBeCloseTo(22.20809090909, 9);
    expect(v[11]).toBeCloseTo(22.24116528926, 9);
    const defined = v.slice(9);
    expect(defined).toHaveLength(INTEL_EMA10.length);
    defined.forEach((x, i) => expect(Math.abs((x ?? NaN) - (INTEL_EMA10[i] ?? NaN))).toBeLessThan(0.0051));
  });

  it('an EMA seeded from the first close would NOT match (the vector can tell the conventions apart)', () => {
    // Guards the guard: if this ever passes, the vector above no longer discriminates.
    const k = 2 / 11;
    let prev = INTEL[0] ?? NaN;
    const wrong: number[] = [prev];
    for (let i = 1; i < INTEL.length; i++) {
      prev += k * ((INTEL[i] ?? NaN) - prev);
      wrong.push(prev);
    }
    expect(Math.abs((wrong[9] ?? NaN) - 22.22)).toBeGreaterThan(0.0001);
    const right = lineValues(computeIndicator(makeBars(INTEL), 'ema', { period: 10 }));
    expect(Math.abs((right[9] ?? NaN) - 22.221)).toBeLessThan(1e-9);
  });
});

// ───────────────────── Hand-derived (NOT published) vectors ─────────────────────
describe('MACD against exact rational arithmetic', () => {
  // No published MACD vector with SMA-seeded EMAs was found (the StockCharts MACD page
  // shows its table as an image, and the CSV derived from it in bukosabino/ta seeds the
  // EMAs from the first close, which violates convention 2). So this is a HAND derivation,
  // done with Python `fractions` and rounded once: closes 1,2,4,7,11,16, MACD(2,3,2).
  // It is evidence for the signal seeding (convention 4), not an independent reference.
  const closes = [1, 2, 4, 7, 11, 16];
  const s = computeIndicator(makeBars(closes), 'macd', { fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 });

  it('macd line starts at slowPeriod - 1', () => {
    const m = lineValues(s, 'macd');
    expect(m.slice(0, 2)).toEqual([null, null]);
    [0.8333333333333334, 1.0555555555555556, 1.4074074074074074, 1.8302469135802468].forEach((e, i) => expect(m[i + 2]).toBeCloseTo(e, 12));
  });

  it('signal seeds from the mean of the first signalPeriod DEFINED macd values, skipping the nulls', () => {
    const sig = lineValues(s, 'signal');
    expect(sig.slice(0, 3)).toEqual([null, null, null]);
    // seed = (0.8333 + 1.0556) / 2. Treating the two leading nulls as zeros would change it.
    [0.9444444444444444, 1.2530864197530864, 1.6378600823045268].forEach((e, i) => expect(sig[i + 3]).toBeCloseTo(e, 12));
  });

  it('histogram is macd - signal, null while signal is null', () => {
    const h = lineValues(s, 'histogram');
    expect(h.slice(0, 3)).toEqual([null, null, null]);
    [0.1111111111111111, 0.15432098765432098, 0.19238683127572018].forEach((e, i) => expect(h[i + 3]).toBeCloseTo(e, 12));
    expect(s.warmup).toBe(2); // slowPeriod - 1; signal/histogram start later (convention 1)
  });
});

// ───────────────────────────── Property tests ─────────────────────────────
const KINDS: [IndicatorKind, IndicatorParams][] = [
  ['sma', { period: 5 }],
  ['ema', { period: 5 }],
  ['rsi', { period: 5 }],
  ['macd', { fastPeriod: 3, slowPeriod: 7, signalPeriod: 4 }],
];

describe('flat series', () => {
  const flat = makeBars(Array<number>(80).fill(123.45));
  it('RSI is exactly 50 once defined', () => {
    const v = lineValues(computeIndicator(flat, 'rsi', { period: 14 }));
    expect(v.slice(14).every((x) => x === 50)).toBe(true);
  });
  it('SMA and EMA equal the constant', () => {
    for (const kind of ['sma', 'ema'] as const) {
      const v = lineValues(computeIndicator(flat, kind, { period: 20 })).slice(19);
      v.forEach((x) => expect(x).toBeCloseTo(123.45, 10));
    }
  });
  it('MACD, signal and histogram are 0 once defined', () => {
    const s = computeIndicator(flat, 'macd', DEFAULT_PARAMS.macd);
    for (const key of LINE_KEYS.macd) {
      lineValues(s, key).forEach((x) => {
        if (x !== null) expect(x).toBeCloseTo(0, 10);
      });
    }
  });
});

describe('monotonic series', () => {
  const up = makeBars(Array.from({ length: 60 }, (_, i) => 10 + i * 0.25));
  const down = makeBars(Array.from({ length: 60 }, (_, i) => 100 - i * 0.25));
  it('rising RSI is exactly 100', () => {
    expect(lineValues(computeIndicator(up, 'rsi', { period: 14 })).slice(14).every((x) => x === 100)).toBe(true);
  });
  it('falling RSI is exactly 0, with no division by zero (never NaN or Infinity)', () => {
    const v = lineValues(computeIndicator(down, 'rsi', { period: 14 })).slice(14);
    expect(v.every((x) => x === 0)).toBe(true);
  });
  it('rising series has a positive MACD, falling a negative one', () => {
    expect(lineValues(computeIndicator(up, 'macd', DEFAULT_PARAMS.macd), 'macd').at(-1)).toBeGreaterThan(0);
    expect(lineValues(computeIndicator(down, 'macd', DEFAULT_PARAMS.macd), 'macd').at(-1)).toBeLessThan(0);
  });
});

describe('RSI after a single drop in a long rally', () => {
  it('stays strictly between 50 and 100: avgLoss decays but never reaches 0', () => {
    const closes = [100, 99, ...Array.from({ length: 200 }, (_, i) => 99 + (i + 1) * 0.5)];
    const v = lineValues(computeIndicator(makeBars(closes), 'rsi', { period: 14 }));
    const last = v.at(-1) ?? NaN;
    expect(last).toBeGreaterThan(99);
    expect(last).toBeLessThan(100);
  });
});

describe('period edge cases', () => {
  const closes = [3, 1, 4, 1, 5, 9, 2, 6];
  it('period 1: SMA and EMA reproduce the input', () => {
    expect(lineValues(computeIndicator(makeBars(closes), 'sma', { period: 1 }))).toEqual(closes);
    expect(lineValues(computeIndicator(makeBars(closes), 'ema', { period: 1 }))).toEqual(closes);
  });
  it('period 1: RSI is 100 after an up bar, 0 after a down bar, 50 after a flat bar', () => {
    const s = computeIndicator(makeBars([1, 2, 1, 1, 3]), 'rsi', { period: 1 });
    expect(lineValues(s)).toEqual([null, 100, 0, 50, 100]);
    expect(s.warmup).toBe(1);
  });
  it('period equal to the bar count: SMA/EMA have exactly one value, at the end', () => {
    for (const kind of ['sma', 'ema'] as const) {
      const s = computeIndicator(makeBars(closes), kind, { period: closes.length });
      const v = lineValues(s);
      expect(s.warmup).toBe(closes.length - 1);
      expect(v.slice(0, -1).every((x) => x === null)).toBe(true);
      expect(v.at(-1)).toBeCloseTo(31 / 8, 12);
    }
  });
  it('RSI needs period + 1 bars: with exactly `period` bars every point is null', () => {
    const s = computeIndicator(makeBars(closes), 'rsi', { period: closes.length });
    expect(lineValues(s).every((x) => x === null)).toBe(true);
    expect(s.warmup).toBe(closes.length);
  });
  it('RSI with period + 1 bars has exactly one value, at the last index', () => {
    const s = computeIndicator(makeBars(closes), 'rsi', { period: closes.length - 1 });
    expect(s.warmup).toBe(closes.length - 1);
    expect(lineValues(s).at(-1)).not.toBeNull();
  });
  it('MACD with exactly slowPeriod bars: only the macd line has one value', () => {
    const s = computeIndicator(makeBars(closes), 'macd', { fastPeriod: 2, slowPeriod: closes.length, signalPeriod: 3 });
    expect(s.warmup).toBe(closes.length - 1);
    expect(lineValues(s, 'macd').filter((x) => x !== null)).toHaveLength(1);
    expect(lineValues(s, 'signal').every((x) => x === null)).toBe(true);
    expect(lineValues(s, 'histogram').every((x) => x === null)).toBe(true);
  });
  it('MACD signalPeriod 1: signal equals the macd line, histogram is 0', () => {
    const s = computeIndicator(makeBars(walk(40)), 'macd', { fastPeriod: 3, slowPeriod: 7, signalPeriod: 1 });
    const m = lineValues(s, 'macd');
    lineValues(s, 'signal').forEach((x, i) => expect(x).toBe(m[i]));
    lineValues(s, 'histogram').forEach((x, i) => expect(x).toBe(m[i] === null ? null : 0));
  });
});

describe.each(KINDS)('%s structural invariants', (kind, params) => {
  it.each([0, 1, 2, 4, 5, 6, 7, 10, 11, 12, 40, 500])('length %i: one point per bar, same times, null through warmup', (n) => {
    const bars = makeBars(walk(n));
    const s = computeIndicator(bars, kind, params);
    expect(s.kind).toBe(kind);
    expect(s.placement).toBe(INDICATOR_PLACEMENT[kind]);
    expect(s.lines.map((l) => l.key)).toEqual([...LINE_KEYS[kind]]);
    expect(s.warmup).toBeGreaterThanOrEqual(0);
    expect(s.warmup).toBeLessThanOrEqual(n);
    for (const line of s.lines) {
      expect(line.points).toHaveLength(n);
      line.points.forEach((p, i) => {
        expect(p.time).toBe((bars[i] as Bar).time);
        if (i < s.warmup) expect(p.value).toBeNull();
        else if (p.value !== null) expect(Number.isFinite(p.value)).toBe(true);
      });
    }
  });

  it('warmup is tight: at least one line is defined at index `warmup` when there are enough bars', () => {
    const s = computeIndicator(makeBars(walk(100)), kind, params);
    expect(s.lines.some((l) => l.points[s.warmup]?.value !== null)).toBe(true);
  });

  it('fewer bars than needed: every point is null and warmup equals the bar count', () => {
    const s = computeIndicator(makeBars(walk(2)), kind, params);
    expect(s.warmup).toBe(2);
    s.lines.forEach((l) => expect(l.points.every((p) => p.value === null)).toBe(true));
  });

  it('empty input gives a well-formed, empty series', () => {
    const s = computeIndicator([], kind, params);
    expect(s.warmup).toBe(0);
    expect(s.lines.map((l) => l.key)).toEqual([...LINE_KEYS[kind]]);
    s.lines.forEach((l) => expect(l.points).toEqual([]));
  });

  it('is deterministic and does not mutate its input', () => {
    const bars = makeBars(walk(60));
    const frozen = JSON.stringify(bars);
    Object.freeze(bars);
    bars.forEach((b) => Object.freeze(b));
    const a = computeIndicator(bars, kind, params);
    const b = computeIndicator(bars, kind, params);
    expect(a).toEqual(b);
    expect(JSON.stringify(bars)).toBe(frozen);
  });

  it('does not emit 0 for warmup (only null)', () => {
    const s = computeIndicator(makeBars(walk(30, 7, 50)), kind, params);
    s.lines.forEach((l) => l.points.slice(0, s.warmup).forEach((p) => expect(p.value).not.toBe(0)));
  });
});

describe('RSI range', () => {
  it('stays within [0, 100] on a volatile series', () => {
    const closes = walk(2000, 99, 100).map((x, i) => x * (i % 7 === 0 ? 1.08 : 0.97));
    lineValues(computeIndicator(makeBars(closes), 'rsi', { period: 14 })).forEach((x) => {
      if (x !== null) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
      }
    });
  });
});

describe('MACD identities on a random walk', () => {
  const bars = makeBars(walk(300, 4242));
  const p = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
  const s = computeIndicator(bars, 'macd', p);
  const macd = lineValues(s, 'macd');
  const signal = lineValues(s, 'signal');
  const hist = lineValues(s, 'histogram');
  const fast = lineValues(computeIndicator(bars, 'ema', { period: 12 }));
  const slow = lineValues(computeIndicator(bars, 'ema', { period: 26 }));

  it('macd = EMA(12) - EMA(26)', () => {
    macd.forEach((m, i) => {
      if (i < 25) expect(m).toBeNull();
      else expect(m).toBeCloseTo((fast[i] ?? NaN) - (slow[i] ?? NaN), 12);
    });
  });
  it('warmup is slowPeriod - 1; signal and histogram start at slow - 1 + signal - 1', () => {
    expect(s.warmup).toBe(25);
    expect(signal.findIndex((x) => x !== null)).toBe(25 + 8);
    expect(hist.findIndex((x) => x !== null)).toBe(25 + 8);
  });
  it('histogram = macd - signal', () => {
    hist.forEach((h, i) => {
      if (h !== null) expect(h).toBeCloseTo((macd[i] ?? NaN) - (signal[i] ?? NaN), 12);
    });
  });
  it('the histogram changes sign exactly where macd crosses signal', () => {
    for (let i = 34; i < bars.length; i++) {
      const h0 = hist[i - 1] as number;
      const h1 = hist[i] as number;
      const d0 = (macd[i - 1] as number) - (signal[i - 1] as number);
      const d1 = (macd[i] as number) - (signal[i] as number);
      expect(Math.sign(h0)).toBe(Math.sign(d0));
      expect(Math.sign(h1)).toBe(Math.sign(d1));
    }
  });
});

describe('EMA is not an SMA and RSI is not a simple-mean RSI', () => {
  it('after a spike, EMA stays above the SMA of the same period only transiently and differs from it', () => {
    const closes = [...Array<number>(30).fill(10), 20, ...Array<number>(30).fill(10)];
    const ema = lineValues(computeIndicator(makeBars(closes), 'ema', { period: 10 }));
    const sma = lineValues(computeIndicator(makeBars(closes), 'sma', { period: 10 }));
    // 1 bar after the spike the EMA has decayed geometrically while the SMA still holds 1/10 of it.
    expect(ema[31]).not.toBeCloseTo(sma[31] ?? NaN, 3);
    // 10 bars later the SMA window has fully forgotten the spike; the EMA never does.
    expect(sma[41]).toBeCloseTo(10, 12);
    expect((ema[41] ?? NaN) - 10).toBeGreaterThan(0.1);
  });
  it('RSI uses Wilder smoothing: it differs from the simple-mean RSI after the first window', () => {
    const closes = walk(120, 5);
    const v = lineValues(computeIndicator(makeBars(closes), 'rsi', { period: 14 }));
    const simple = (i: number): number => {
      let g = 0;
      let l = 0;
      for (let j = i - 13; j <= i; j++) {
        const d = (closes[j] as number) - (closes[j - 1] as number);
        if (d > 0) g += d;
        else l -= d;
      }
      return (100 * g) / (g + l);
    };
    expect(v[14]).toBeCloseTo(simple(14), 10); // seed window: identical by construction
    expect(Math.abs((v[60] ?? NaN) - simple(60))).toBeGreaterThan(0.01); // afterwards: not
  });
});

describe('source on SMA/EMA (convention 6)', () => {
  const bars = makeBars(walk(40));
  it("defaults to 'close' when absent and when explicit", () => {
    const a = lineValues(computeIndicator(bars, 'sma', { period: 5 }));
    expect(lineValues(computeIndicator(bars, 'sma', { period: 5, source: 'close' }))).toEqual(a);
  });
  it.each(['open', 'high', 'low', 'close'] as const)('averages the %s field', (source) => {
    const expected = bars.slice(0, 4).reduce((acc, b) => acc + b[source], 0) / 4;
    expect(lineValues(computeIndicator(bars, 'sma', { period: 4, source }))[3]).toBeCloseTo(expected, 10);
    expect(lineValues(computeIndicator(bars, 'ema', { period: 4, source }))[3]).toBeCloseTo(expected, 10);
  });
  it('different sources give different lines', () => {
    const high = lineValues(computeIndicator(bars, 'ema', { period: 5, source: 'high' }));
    const low = lineValues(computeIndicator(bars, 'ema', { period: 5, source: 'low' }));
    expect(high[20]).not.toBe(low[20]);
  });
});

describe('metadata', () => {
  it('labels name the indicator and its parameters', () => {
    const bars = makeBars(walk(50));
    expect(computeIndicator(bars, 'sma', { period: 20 }).lines[0]?.label).toBe('SMA (20)');
    expect(computeIndicator(bars, 'ema', { period: 9, source: 'high' }).lines[0]?.label).toBe('EMA (9, high)');
    expect(computeIndicator(bars, 'rsi', { period: 14 }).lines[0]?.label).toBe('RSI (14)');
    expect(computeIndicator(bars, 'macd', DEFAULT_PARAMS.macd).lines.map((l) => l.label)).toEqual([
      'MACD (12,26,9)',
      'Signal (12,26,9)',
      'Histogram (12,26,9)',
    ]);
  });
  it('echoes the params it was given', () => {
    const bars = makeBars(walk(50));
    expect(computeIndicator(bars, 'sma', { period: 20 }).params).toEqual({ period: 20 });
    expect(computeIndicator(bars, 'ema', { period: 20, source: 'low' }).params).toEqual({ period: 20, source: 'low' });
    expect(computeIndicator(bars, 'macd', DEFAULT_PARAMS.macd).params).toEqual(DEFAULT_PARAMS.macd);
  });
  it('every default parameter set is valid', () => {
    for (const kind of ['sma', 'ema', 'rsi', 'macd', 'volume', 'vpvr', 'liquidity'] as const) {
      expect(checkIndicatorParams(kind, DEFAULT_PARAMS[kind])).toBeNull();
    }
  });
});

describe('parameter validation', () => {
  const bars = makeBars(walk(40));
  it.each([0, -1, 501, 1.5, NaN, Infinity])('rejects period %s', (period) => {
    for (const kind of ['sma', 'ema', 'rsi'] as const) {
      expect(() => computeIndicator(bars, kind, { period })).toThrow(InvalidIndicatorParamsError);
    }
  });
  it('accepts the bounds 1 and 500', () => {
    expect(() => computeIndicator(bars, 'sma', { period: 1 })).not.toThrow();
    expect(() => computeIndicator(bars, 'sma', { period: PERIOD_MAX })).not.toThrow();
  });
  it('rejects a MACD with fast >= slow, equal or inverted', () => {
    expect(() => computeIndicator(bars, 'macd', { fastPeriod: 26, slowPeriod: 26, signalPeriod: 9 })).toThrow(InvalidIndicatorParamsError);
    expect(() => computeIndicator(bars, 'macd', { fastPeriod: 30, slowPeriod: 26, signalPeriod: 9 })).toThrow(/fastPeriod/);
  });
  it('rejects out-of-range MACD periods', () => {
    expect(() => computeIndicator(bars, 'macd', { fastPeriod: 0, slowPeriod: 26, signalPeriod: 9 })).toThrow(InvalidIndicatorParamsError);
    expect(() => computeIndicator(bars, 'macd', { fastPeriod: 12, slowPeriod: 501, signalPeriod: 9 })).toThrow(InvalidIndicatorParamsError);
    expect(() => computeIndicator(bars, 'macd', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 0 })).toThrow(InvalidIndicatorParamsError);
  });
  it('rejects params whose shape does not match the kind, and unknown kinds', () => {
    expect(() => computeIndicator(bars, 'macd', { period: 14 })).toThrow(InvalidIndicatorParamsError);
    expect(() => computeIndicator(bars, 'rsi', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 })).toThrow(InvalidIndicatorParamsError);
    expect(() => computeIndicator(bars, 'wma' as IndicatorKind, { period: 5 })).toThrow(/unknown indicator kind/);
  });
  it('rejects an unknown source', () => {
    expect(() => computeIndicator(bars, 'sma', { period: 5, source: 'volume' as 'close' })).toThrow(/source/);
  });
  it('validates even when there are no bars', () => {
    expect(() => computeIndicator([], 'sma', { period: 0 })).toThrow(InvalidIndicatorParamsError);
  });
  it('checkIndicatorParams reports the message without throwing', () => {
    expect(checkIndicatorParams('rsi', { period: 0 })).toMatch(/period/);
    expect(checkIndicatorParams('rsi', { period: 14 })).toBeNull();
  });
});

describe('performance', () => {
  // A regression guard with generous headroom for a loaded CI box under jsdom; the real
  // target (well under 16 ms) is measured separately and reported, not asserted here.
  it('recomputes 5,000 bars of every indicator quickly', () => {
    const bars = makeBars(walk(5000, 1));
    const run = (): void => {
      for (const [kind, params] of KINDS) computeIndicator(bars, kind, params);
      computeIndicator(bars, 'sma', { period: 500 });
      computeIndicator(bars, 'macd', DEFAULT_PARAMS.macd);
    };
    run(); // warm the JIT
    const t0 = performance.now();
    run();
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('volume', () => {
  // makeBars gives volume 1000 + i, so the MA has a closed form: the mean of a run of
  // consecutive integers is its midpoint.
  const bars = makeBars(walk(30));

  it('the volume line is each bar\'s volume, defined from the first bar', () => {
    const s = computeIndicator(bars, 'volume', { period: 5 });
    expect(lineValues(s, 'volume')).toEqual(bars.map((b) => b.volume));
    expect(s.warmup).toBe(0);
    expect(s.placement).toBe('overlay');
    expect(s.lines.map((l) => [l.key, l.label])).toEqual([
      ['volume', 'Volume'],
      ['ma', 'Volume MA (5)'],
    ]);
  });

  it('the ma line is the SMA of the volume: null for period - 1 bars, then the window mean', () => {
    const ma = lineValues(computeIndicator(bars, 'volume', { period: 5 }), 'ma');
    expect(ma.slice(0, 4)).toEqual([null, null, null, null]);
    // Bars 0..4 have volumes 1000..1004; their mean is 1002. Bar i's window mean is 1000 + i - 2.
    ma.slice(4).forEach((v, k) => expect(v).toBeCloseTo(1000 + (k + 4) - 2, 9));
  });

  it('uses volume, not price: a change of closes leaves it alone', () => {
    const other = bars.map((b) => ({ ...b, open: b.open * 3, high: b.high * 3, low: b.low * 3, close: b.close * 3 }));
    expect(computeIndicator(other, 'volume', { period: 5 }).lines).toEqual(computeIndicator(bars, 'volume', { period: 5 }).lines);
  });

  it('with fewer bars than the period, the volume still shows and the MA is all null', () => {
    const s = computeIndicator(makeBars(walk(3)), 'volume', { period: 5 });
    expect(lineValues(s, 'volume')).toEqual([1000, 1001, 1002]);
    expect(lineValues(s, 'ma')).toEqual([null, null, null]);
    expect(s.warmup).toBe(0);
  });

  it('rejects a period out of bounds, like the other kinds', () => {
    expect(() => computeIndicator(bars, 'volume', { period: 0 })).toThrow(InvalidIndicatorParamsError);
    expect(() => computeIndicator(bars, 'volume', { period: PERIOD_MAX + 1 })).toThrow(InvalidIndicatorParamsError);
  });
});

describe('vpvr', () => {
  it('has no lines: the profile is drawn from the visible bars (convention 8)', () => {
    const s = computeIndicator(makeBars(walk(30)), 'vpvr', DEFAULT_PARAMS.vpvr);
    expect(s).toEqual({ kind: 'vpvr', placement: 'overlay', params: DEFAULT_PARAMS.vpvr, lines: [], warmup: 0 });
  });

  it.each([
    [{ rows: 1, widthPct: 30, valueAreaPct: 70 }, /rows/],
    [{ rows: 401, widthPct: 30, valueAreaPct: 70 }, /rows/],
    [{ rows: 24, widthPct: 4, valueAreaPct: 70 }, /widthPct/],
    [{ rows: 24, widthPct: 30, valueAreaPct: 101 }, /valueAreaPct/],
    [{ rows: 24.5, widthPct: 30, valueAreaPct: 70 }, /rows/],
  ])('rejects %j', (params, message) => {
    expect(checkIndicatorParams('vpvr', params)).toMatch(message);
    expect(() => computeIndicator(makeBars(walk(5)), 'vpvr', params)).toThrow(InvalidIndicatorParamsError);
  });

  it('accepts the bounds themselves', () => {
    expect(checkIndicatorParams('vpvr', { rows: 2, widthPct: 5, valueAreaPct: 0 })).toBeNull();
    expect(checkIndicatorParams('vpvr', { rows: 400, widthPct: 90, valueAreaPct: 100 })).toBeNull();
  });
});

describe('liquidity params', () => {
  const ok = DEFAULT_PARAMS.liquidity;

  it('has no lines: zones and sweeps are drawings (convention 9)', () => {
    const s = computeIndicator(makeBars(walk(30)), 'liquidity', ok);
    expect(s).toEqual({ kind: 'liquidity', placement: 'overlay', params: ok, lines: [], warmup: 0 });
  });

  it('defaults to lookback 10, wick zones, wick sweeps, 0 touches, age 300, sweep length 20', () => {
    expect(ok).toEqual({ lookback: 10, zoneMode: 'wick', sweepMode: 'wicks', minTouches: 0, maxAge: 300, sweepExtend: 20 });
  });

  it('accepts the bounds themselves and every enum value', () => {
    expect(checkIndicatorParams('liquidity', { ...ok, lookback: 2, minTouches: 0, maxAge: 10, sweepExtend: 1 })).toBeNull();
    expect(checkIndicatorParams('liquidity', { ...ok, lookback: 100, minTouches: 100, maxAge: 5000, sweepExtend: 500 })).toBeNull();
    for (const zoneMode of ['wick', 'range'] as const) {
      for (const sweepMode of ['wicks', 'retests', 'both'] as const) {
        expect(checkIndicatorParams('liquidity', { ...ok, zoneMode, sweepMode })).toBeNull();
      }
    }
  });

  it.each([
    [{ lookback: 1 }, /lookback/],
    [{ lookback: 101 }, /lookback/],
    [{ lookback: 10.5 }, /lookback/],
    [{ minTouches: -1 }, /minTouches/],
    [{ minTouches: 101 }, /minTouches/],
    [{ maxAge: 9 }, /maxAge/],
    [{ maxAge: 5001 }, /maxAge/],
    [{ sweepExtend: 0 }, /sweepExtend/],
    [{ sweepExtend: 501 }, /sweepExtend/],
    [{ zoneMode: 'body' }, /zoneMode/],
    [{ sweepMode: 'all' }, /sweepMode/],
    [{ zoneMode: undefined }, /zoneMode/],
    [{ sweepMode: undefined }, /sweepMode/],
  ])('rejects %j', (patch, message) => {
    const params = { ...ok, ...patch } as never;
    expect(checkIndicatorParams('liquidity', params)).toMatch(message);
    expect(() => computeIndicator(makeBars(walk(5)), 'liquidity', params)).toThrow(InvalidIndicatorParamsError);
  });

  it('rejects params of another kind', () => {
    expect(checkIndicatorParams('liquidity', { period: 20 } as never)).toMatch(/lookback/);
  });
});

