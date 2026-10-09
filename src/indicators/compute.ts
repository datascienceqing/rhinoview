/**
 * `ComputeIndicator` — SMA, EMA, RSI, MACD and Volume as pure functions of bars and params.
 *
 * No React, DOM, network, clock or randomness. Same input, same output. The math lives
 * in `math.ts`; this file validates, picks the source series, and shapes the result into
 * the frozen `IndicatorSeries` (one point per bar, same times, `null` through warmup).
 */
import type { Bar, IndicatorLine, IndicatorSeries, MacdParams, MovingAverageParams, RsiParams, VolumeParams } from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';
import { macd as macdKernel, ema, rsi as rsiKernel, sma } from './math';
import { assertValidParams } from './params';
import type { ComputeIndicator } from './types';

type PriceSource = NonNullable<MovingAverageParams['source']> | 'volume';

function extract(bars: readonly Bar[], source: PriceSource): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = (bars[i] as Bar)[source];
  return out;
}

/** NaN -> null here and nowhere else, so "no value" can never leak out as a number. */
function toLine(key: string, label: string, bars: readonly Bar[], values: Float64Array): IndicatorLine {
  const points = new Array<IndicatorLine['points'][number]>(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const v = values[i] as number;
    points[i] = { time: (bars[i] as Bar).time, value: Number.isNaN(v) ? null : v };
  }
  return { key, label, points };
}

/** Count of leading bars for which NO line has a value, capped at the bar count. */
function warmupOf(n: number, ...lines: Float64Array[]): number {
  let warmup = n;
  for (const values of lines) {
    let i = 0;
    while (i < warmup && Number.isNaN(values[i] as number)) i++;
    warmup = Math.min(warmup, i);
  }
  return warmup;
}

export const computeIndicator: ComputeIndicator = (bars, kind, params): IndicatorSeries => {
  assertValidParams(kind, params);
  const placement = INDICATOR_PLACEMENT[kind];
  const n = bars.length;

  if (kind === 'macd') {
    const { fastPeriod, slowPeriod, signalPeriod } = params as MacdParams;
    const { macd, signal, histogram } = macdKernel(extract(bars, 'close'), fastPeriod, slowPeriod, signalPeriod);
    const tag = `${fastPeriod},${slowPeriod},${signalPeriod}`;
    return {
      kind,
      placement,
      params: { fastPeriod, slowPeriod, signalPeriod },
      lines: [
        toLine('macd', `MACD (${tag})`, bars, macd),
        toLine('signal', `Signal (${tag})`, bars, signal),
        toLine('histogram', `Histogram (${tag})`, bars, histogram),
      ],
      // The MACD line is the earliest-defined of the three; signal/histogram start later.
      warmup: warmupOf(n, macd, signal, histogram),
    };
  }

  if (kind === 'volume') {
    const { period } = params as VolumeParams;
    const volume = extract(bars, 'volume');
    const ma = sma(volume, period);
    return {
      kind,
      placement,
      params: { period },
      lines: [toLine('volume', 'Volume', bars, volume), toLine('ma', `Volume MA (${period})`, bars, ma)],
      // The volume line is defined from the first bar (convention 7).
      warmup: warmupOf(n, volume, ma),
    };
  }

  if (kind === 'rsi') {
    const { period } = params as RsiParams;
    const values = rsiKernel(extract(bars, 'close'), period);
    return {
      kind,
      placement,
      params: { period },
      lines: [toLine('value', `RSI (${period})`, bars, values)],
      warmup: warmupOf(n, values),
    };
  }

  // sma | ema — `source` defaults to 'close' (convention 6).
  const { period, source } = params as MovingAverageParams;
  const input = extract(bars, source ?? 'close');
  const values = kind === 'sma' ? sma(input, period) : ema(input, period);
  const label = `${kind.toUpperCase()} (${source !== undefined && source !== 'close' ? `${period}, ${source}` : period})`;
  return {
    kind,
    placement,
    params: source === undefined ? { period } : { period, source },
    lines: [toLine('value', label, bars, values)],
    warmup: warmupOf(n, values),
  };
};
