/**
 * Indicator math for the ORACLE / DEBUG endpoint only. Application code does not call
 * this; runtime indicators are computed client-side in `src/indicators/`.
 *
 * This is deliberately an independent implementation (not an import from `src/`):
 * the endpoint's one job is to give the client math something to disagree with. It is
 * still only a *consistency* check — it runs on the same engine bars the client sees,
 * so a bug in how bars are produced is invisible to it.
 *
 * Conventions (warmup is `null`, never 0):
 *   SMA(n)   — mean of last n closes; first value at index n-1.
 *   EMA(n)   — k = 2/(n+1), seeded with SMA(n) at index n-1.
 *   RSI(n)   — Wilder smoothing, seeded with the simple mean of the first n gains and
 *              losses; first value at index n. Flat series (no gains, no losses) = 50.
 *   MACD     — EMA(fast) - EMA(slow) from index slow-1; signal = EMA(signalPeriod) of
 *              the MACD line, seeded with its SMA; histogram = macd - signal.
 *   VOLUME(n) — line 'volume' = each bar's volume (no warmup); line 'ma' = SMA(n) of it.
 */
import type { Bar, IndicatorLine, IndicatorPoint, IndicatorSeries } from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';

export type IndicatorRequest =
  | { kind: 'sma' | 'ema' | 'rsi' | 'volume'; period: number }
  | { kind: 'macd'; fastPeriod: number; slowPeriod: number; signalPeriod: number };

type Series = (number | null)[];

function sma(values: Series, period: number): Series {
  const out: Series = new Array<number | null>(values.length).fill(null);
  // Values may start with nulls (e.g. the MACD line); the window must be fully defined.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > period) {
      const old = values[i - period];
      if (old !== null && old !== undefined) sum -= old;
      count--;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

function ema(values: Series, period: number): Series {
  const out: Series = new Array<number | null>(values.length).fill(null);
  const seed = sma(values, period);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      const s = seed[i];
      if (s !== null && s !== undefined) {
        prev = s;
        out[i] = s;
      }
    } else if (v !== null && v !== undefined) {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes: number[], period: number): Series {
  const out: Series = new Array<number | null>(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const toRsi = (g: number, l: number): number => {
    if (g === 0 && l === 0) return 50;
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  };
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function line(key: string, label: string, bars: Bar[], values: Series): IndicatorLine {
  const points: IndicatorPoint[] = bars.map((b, i) => ({ time: b.time, value: values[i] ?? null }));
  return { key, label, points };
}

function firstDefined(values: Series): number {
  const i = values.findIndex((v) => v !== null);
  return i === -1 ? values.length : i;
}

export function computeIndicator(bars: Bar[], req: IndicatorRequest): IndicatorSeries {
  const closes = bars.map((b) => b.close);
  const placement = INDICATOR_PLACEMENT[req.kind];

  if (req.kind === 'macd') {
    const { fastPeriod, slowPeriod, signalPeriod } = req;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    const macd: Series = closes.map((_, i) => {
      const f = fast[i];
      const s = slow[i];
      return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
    });
    const signal = ema(macd, signalPeriod);
    const hist: Series = macd.map((m, i) => {
      const s = signal[i];
      return m !== null && s !== null && s !== undefined ? m - s : null;
    });
    const tag = `${fastPeriod},${slowPeriod},${signalPeriod}`;
    return {
      kind: 'macd',
      placement,
      params: { fastPeriod, slowPeriod, signalPeriod },
      lines: [
        line('macd', `MACD (${tag})`, bars, macd),
        line('signal', `Signal (${tag})`, bars, signal),
        line('histogram', `Histogram (${tag})`, bars, hist),
      ],
      // Leading bars where NO line has a value. The signal/histogram lines start later.
      warmup: firstDefined(macd),
    };
  }

  if (req.kind === 'volume') {
    const volume: Series = bars.map((b) => b.volume);
    const ma = sma(volume, req.period);
    return {
      kind: 'volume',
      placement,
      params: { period: req.period },
      lines: [line('volume', 'Volume', bars, volume), line('ma', `Volume MA (${req.period})`, bars, ma)],
      warmup: Math.min(firstDefined(volume), firstDefined(ma)),
    };
  }

  const values = req.kind === 'sma' ? sma(closes, req.period) : req.kind === 'ema' ? ema(closes, req.period) : rsi(closes, req.period);
  return {
    kind: req.kind,
    placement,
    params: { period: req.period },
    lines: [line('value', `${req.kind.toUpperCase()} (${req.period})`, bars, values)],
    warmup: firstDefined(values),
  };
}
