import type {
  Bar,
  IndicatorKind,
  IndicatorLine,
  IndicatorParams,
  IndicatorSeries,
  MacdParams,
  MovingAverageParams,
  RsiParams,
} from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';
import { InvalidIndicatorParamsError, PERIOD_MAX, PERIOD_MIN } from '../../indicators/types';
import type { ComputeIndicator } from '../../indicators/types';

/**
 * Pane UI's own stand-in for Worker C's math, written against the frozen
 * `ComputeIndicator` signature so the UI could be built and browser-verified without
 * waiting. It follows the seam's conventions (null warmup, EMA seeded with the SMA,
 * Wilder RSI, one point per bar) but is NOT the source of truth: the real module is
 * selected in `computeSource.ts`; this one is now used by tests only.
 */

type Values = (number | null)[];

function checkPeriod(name: string, n: number): void {
  if (!Number.isInteger(n) || n < PERIOD_MIN || n > PERIOD_MAX) {
    throw new InvalidIndicatorParamsError(`${name} must be an integer in [${PERIOD_MIN}, ${PERIOD_MAX}]`);
  }
}

function sma(values: Values, period: number): Values {
  const out: Values = values.map(() => null);
  let sum = 0;
  let count = 0; // defined values currently in the window
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

/** EMA seeded with the SMA of the first `period` DEFINED values; nulls before that are skipped, not zeroed. */
function ema(values: Values, period: number): Values {
  const out: Values = values.map(() => null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  const seed: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (prev === null) {
      seed.push(v);
      if (seed.length === period) {
        prev = seed.reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes: number[], period: number): Values {
  const out: Values = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  const toRsi = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= period;
  loss /= period;
  out[period] = toRsi(gain, loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

function line(key: string, label: string, bars: readonly Bar[], values: Values): IndicatorLine {
  return { key, label, points: bars.map((b, i) => ({ time: b.time, value: values[i] ?? null })) };
}

function firstDefined(...lines: Values[]): number {
  let min = Infinity;
  for (const l of lines) {
    const i = l.findIndex((v) => v !== null);
    if (i >= 0) min = Math.min(min, i);
  }
  return min === Infinity ? 0 : min;
}

export const fakeComputeIndicator: ComputeIndicator = (bars, kind: IndicatorKind, params: IndicatorParams) => {
  const placement = INDICATOR_PLACEMENT[kind];
  switch (kind) {
    case 'sma':
    case 'ema': {
      const p = params as MovingAverageParams;
      checkPeriod('period', p.period);
      const source = p.source ?? 'close';
      const input: Values = bars.map((b) => b[source]);
      const values = kind === 'sma' ? sma(input, p.period) : ema(input, p.period);
      const name = kind.toUpperCase();
      return {
        kind,
        placement,
        params,
        lines: [line('value', `${name} (${p.period})`, bars, values)],
        warmup: Math.min(p.period - 1, bars.length),
      };
    }
    case 'rsi': {
      const p = params as RsiParams;
      checkPeriod('period', p.period);
      const values = rsi(
        bars.map((b) => b.close),
        p.period,
      );
      return {
        kind,
        placement,
        params,
        lines: [line('value', `RSI (${p.period})`, bars, values)],
        warmup: Math.min(p.period, bars.length),
      };
    }
    case 'macd': {
      const p = params as MacdParams;
      checkPeriod('fastPeriod', p.fastPeriod);
      checkPeriod('slowPeriod', p.slowPeriod);
      checkPeriod('signalPeriod', p.signalPeriod);
      if (p.fastPeriod >= p.slowPeriod) throw new InvalidIndicatorParamsError('fastPeriod must be < slowPeriod');
      const closes: Values = bars.map((b) => b.close);
      const fast = ema(closes, p.fastPeriod);
      const slow = ema(closes, p.slowPeriod);
      const macd: Values = closes.map((_, i) => {
        const f = fast[i];
        const s = slow[i];
        return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
      });
      const signal = ema(macd, p.signalPeriod);
      const hist: Values = macd.map((m, i) => {
        const s = signal[i];
        return m !== null && s !== null && s !== undefined ? m - s : null;
      });
      const label = `(${p.fastPeriod},${p.slowPeriod},${p.signalPeriod})`;
      const series: IndicatorSeries = {
        kind,
        placement,
        params,
        lines: [
          line('macd', `MACD ${label}`, bars, macd),
          line('signal', `Signal ${label}`, bars, signal),
          line('histogram', `Histogram ${label}`, bars, hist),
        ],
        warmup: Math.min(firstDefined(macd), bars.length),
      };
      return series;
    }
    case 'volume': {
      const p = params as RsiParams; // `{ period }`, the same shape
      checkPeriod('period', p.period);
      const volume: Values = bars.map((b) => b.volume);
      return {
        kind,
        placement,
        params,
        lines: [line('volume', 'Volume', bars, volume), line('ma', `Volume MA (${p.period})`, bars, sma(volume, p.period))],
        warmup: 0,
      };
    }
    case 'vpvr':
      // Drawn from the visible bars at draw time; no lines.
      return { kind, placement, params, lines: [], warmup: 0 };
    case 'liquidity':
      // Drawn as zones and sweeps; no lines.
      return { kind, placement, params, lines: [], warmup: 0 };
    case 'confluence':
      // Drawn as clusters and events; no lines.
      return { kind, placement, params, lines: [], warmup: 0 };
  }
};
