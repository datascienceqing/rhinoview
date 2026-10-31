/**
 * Indicator kernels the AI facts need and the chart does not have: ADX, Bollinger bands,
 * the rating score, monthly bars, and volume signals.
 *
 * Same conventions as `src/indicators/math.ts`: pure functions over `Float64Array`, the
 * same length as the input, `NaN` for "no value".
 */
import type { Bar } from '@shared/types';
import { ema, macd, rsi, sma } from '../../../src/indicators/math';

export interface Columns {
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

export function columns(bars: readonly Bar[]): Columns {
  const pick = (k: 'open' | 'high' | 'low' | 'close' | 'volume') => Float64Array.from(bars, (b) => b[k]);
  return { open: pick('open'), high: pick('high'), low: pick('low'), close: pick('close'), volume: pick('volume') };
}

/** The last finite value of `values`, or null. */
export function last(values: Float64Array): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i] as number;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** The value `back` bars before the last one, or null when it has no value. */
export function back(values: Float64Array, bars: number): number | null {
  const v = values[values.length - 1 - bars];
  return v !== undefined && Number.isFinite(v) ? v : null;
}

export interface AdxArrays {
  adx: Float64Array;
  plusDi: Float64Array;
  minusDi: Float64Array;
}

/**
 * ADX with Wilder smoothing, like Pine's `ta.dmi`. +DI and -DI start at index `period`
 * (the first bar has no previous bar); ADX starts `period - 1` bars after them.
 */
export function adx(high: Float64Array, low: Float64Array, close: Float64Array, period: number): AdxArrays {
  const n = high.length;
  const out = { adx: new Float64Array(n).fill(NaN), plusDi: new Float64Array(n).fill(NaN), minusDi: new Float64Array(n).fill(NaN) };
  if (n <= period * 2) return out;
  let tr = 0;
  let plus = 0;
  let minus = 0;
  const dx = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = (high[i] as number) - (high[i - 1] as number);
    const down = (low[i - 1] as number) - (low[i] as number);
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const t = Math.max(
      (high[i] as number) - (low[i] as number),
      Math.abs((high[i] as number) - (close[i - 1] as number)),
      Math.abs((low[i] as number) - (close[i - 1] as number)),
    );
    if (i <= period) {
      // Seed: the plain sums of the first `period` values.
      tr += t;
      plus += pdm;
      minus += mdm;
      if (i < period) continue;
    } else {
      tr = tr - tr / period + t;
      plus = plus - plus / period + pdm;
      minus = minus - minus / period + mdm;
    }
    const p = tr > 0 ? (100 * plus) / tr : 0;
    const m = tr > 0 ? (100 * minus) / tr : 0;
    out.plusDi[i] = p;
    out.minusDi[i] = m;
    dx[i] = p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : 0;
  }
  let avg = 0;
  for (let i = period; i < period * 2; i++) avg += dx[i] as number;
  avg /= period;
  out.adx[period * 2 - 1] = avg;
  for (let i = period * 2; i < n; i++) {
    avg = (avg * (period - 1) + (dx[i] as number)) / period;
    out.adx[i] = avg;
  }
  return out;
}

export interface BandArrays {
  basis: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

/** Bollinger bands: SMA(period) ± mult × the population standard deviation, like Pine's `ta.bb`. */
export function bollinger(close: Float64Array, period: number, mult: number): BandArrays {
  const n = close.length;
  const basis = sma(close, period);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const mean = basis[i] as number;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += ((close[j] as number) - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { basis, upper, lower };
}

export type RatingLabel = 'Strong Sell' | 'Sell' | 'Neutral' | 'Buy' | 'Strong Buy';

export interface Rating {
  /** −1 to +1: the mean of the MA part and the oscillator part. */
  score: number;
  maScore: number;
  oscillatorScore: number;
  label: RatingLabel;
}

/** The bands of the skill: under −0.5, −0.5 to −0.1, −0.1 to +0.1, +0.1 to +0.5, over +0.5. */
export function ratingLabel(score: number): RatingLabel {
  if (score < -0.5) return 'Strong Sell';
  if (score < -0.1) return 'Sell';
  if (score <= 0.1) return 'Neutral';
  if (score <= 0.5) return 'Buy';
  return 'Strong Buy';
}

const RATING_MA_PERIODS = [10, 20, 30, 50, 100, 200] as const;

/**
 * Our own rating on the last bar, in the style of a technical summary. It is not a copy of
 * any vendor's rating, so its scores can differ from a score on another platform.
 *
 * - MA part: one vote for each EMA and SMA of RATING_MA_PERIODS that has a value. +1 when
 *   the close is above it, −1 when below.
 * - Oscillator part: RSI14 (+1 under 30 and rising, −1 over 70 and falling), MACD (+1 line
 *   over signal, −1 under), momentum 10 (+1 rising, −1 falling), DMI (+1 when +DI > −DI with
 *   ADX over 20, −1 for the mirror).
 *
 * Null when no MA has a value (too few bars).
 */
export function rating(bars: readonly Bar[]): Rating | null {
  const c = columns(bars);
  const close = last(c.close);
  if (close === null) return null;
  const maVotes: number[] = [];
  for (const p of RATING_MA_PERIODS) {
    for (const kernel of [ema, sma]) {
      const v = last(kernel(c.close, p));
      if (v !== null && bars.length >= p) maVotes.push(close > v ? 1 : close < v ? -1 : 0);
    }
  }
  if (maVotes.length === 0) return null;

  const osc: number[] = [];
  const r = rsi(c.close, 14);
  const r0 = last(r);
  const r1 = back(r, 1);
  if (r0 !== null && r1 !== null) osc.push(r0 < 30 && r0 > r1 ? 1 : r0 > 70 && r0 < r1 ? -1 : 0);
  const m = macd(c.close, 12, 26, 9);
  const line = last(m.macd);
  const signal = last(m.signal);
  if (line !== null && signal !== null) osc.push(line > signal ? 1 : line < signal ? -1 : 0);
  if (bars.length > 11) {
    const mom = (k: number) => (c.close[c.close.length - 1 - k] as number) - (c.close[c.close.length - 11 - k] as number);
    osc.push(mom(0) > mom(1) ? 1 : mom(0) < mom(1) ? -1 : 0);
  }
  const d = adx(c.high, c.low, c.close, 14);
  const a = last(d.adx);
  const p = last(d.plusDi);
  const n = last(d.minusDi);
  if (a !== null && p !== null && n !== null) osc.push(a > 20 && p > n ? 1 : a > 20 && n > p ? -1 : 0);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const maScore = mean(maVotes);
  const oscillatorScore = mean(osc);
  const score = osc.length ? (maScore + oscillatorScore) / 2 : maScore;
  return { score, maScore, oscillatorScore, label: ratingLabel(score) };
}

/** Monthly bars folded from weekly bars. A week belongs to the month of its first day (UTC). */
export function monthlyFromWeekly(weekly: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let key = '';
  for (const w of weekly) {
    const d = new Date(w.time * 1000);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const cur = out[out.length - 1];
    if (k !== key || !cur) {
      key = k;
      out.push({ ...w, vwap: null, transactions: null });
      continue;
    }
    cur.high = Math.max(cur.high, w.high);
    cur.low = Math.min(cur.low, w.low);
    cur.close = w.close;
    cur.volume += w.volume;
  }
  return out;
}

/** Volume of each bar divided by the mean of the `length` bars before it. */
export function volumeRatio(volume: Float64Array, length: number): Float64Array {
  const n = volume.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i >= length) {
      out[i] = sum > 0 ? (volume[i] as number) / (sum / length) : NaN;
      sum -= volume[i - length] as number;
    }
    sum += volume[i] as number;
  }
  return out;
}

/** The volume average length of the skill (backtest, docs/ai-samples/BACKTEST_REPORT.md). */
export const VOLUME_AVERAGE_BARS = 20;

export interface VolumeSignals {
  /** The newest bar of the last 10 with volume ≥ 2.5× average and a range ≥ 1.5× ATR. */
  capitulation: { index: number; time: number; ratio: number } | null;
  /** The mean volume ratio of the last 3 bars is 0.6 or less. */
  dryUp: boolean;
  /** The mean volume ratio of the last 3 bars. */
  recentRatio: number | null;
}

/** Heuristic signs of a low (or a high). The thresholds are ours; the skill names them, it does not tune them. */
export function volumeSignals(bars: readonly Bar[], atrValues: Float64Array): VolumeSignals {
  const c = columns(bars);
  const ratio = volumeRatio(c.volume, VOLUME_AVERAGE_BARS);
  const n = bars.length;
  let capitulation: VolumeSignals['capitulation'] = null;
  for (let i = n - 1; i >= Math.max(0, n - 10); i--) {
    const r = ratio[i] as number;
    const a = atrValues[i] as number;
    const bar = bars[i];
    if (!bar || !Number.isFinite(r) || !Number.isFinite(a)) continue;
    if (r >= 2.5 && bar.high - bar.low >= 1.5 * a) {
      capitulation = { index: i, time: bar.time, ratio: r };
      break;
    }
  }
  const recent = [ratio[n - 1], ratio[n - 2], ratio[n - 3]].filter((x): x is number => x !== undefined && Number.isFinite(x));
  const recentRatio = recent.length === 3 ? recent.reduce((s, x) => s + x, 0) / 3 : null;
  return { capitulation, dryUp: recentRatio !== null && recentRatio <= 0.6, recentRatio };
}
