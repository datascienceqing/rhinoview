/**
 * Numeric kernels for the indicators. Pure functions over `Float64Array`.
 *
 * "No value" is `NaN` inside this file only: a typed array cannot hold `null`, and
 * keeping the hot loops on unboxed doubles is what lets a recompute fit in a frame.
 * `compute.ts` converts NaN to `null` exactly once, at the boundary, so a NaN can never
 * reach the renderer (and a `0` can never stand in for "undefined" — see convention 1
 * in `types.ts`).
 *
 * Every kernel returns an array the same length as its input, with `NaN` for the
 * leading undefined region.
 *
 * Contiguity: `values` is defined from index `from` to the end. That is true of closes
 * (`from` = 0) and of the MACD line (`from` = slowPeriod - 1), and it is what lets the
 * MACD signal skip the leading undefined values instead of treating them as zeros
 * (convention 4).
 */

/** Mean of `values[start .. start+count)`, accumulated with Neumaier compensation. */
function windowMean(values: Float64Array, start: number, count: number): number {
  let sum = 0;
  let comp = 0;
  for (let i = start; i < start + count; i++) {
    const v = values[i] as number;
    const t = sum + v;
    comp += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return (sum + comp) / count;
}

/**
 * Simple moving average. First value at index `from + period - 1`.
 *
 * Rolling sum with Neumaier compensation: a plain running sum accumulates one rounding
 * error per bar and drifts away from the exact mean on long series; the compensation
 * term keeps the error at the level of a single rounding regardless of length.
 */
export function sma(values: Float64Array, period: number, from = 0): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const first = from + period - 1;
  if (first >= n) return out;

  let sum = 0;
  let comp = 0;
  const add = (v: number): void => {
    const t = sum + v;
    comp += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  };

  for (let i = from; i < first; i++) add(values[i] as number);
  for (let i = first; i < n; i++) {
    add(values[i] as number);
    out[i] = (sum + comp) / period;
    add(-(values[i - period + 1] as number));
  }
  return out;
}

/**
 * Exponential moving average, multiplier `2 / (period + 1)`, seeded with the SMA of the
 * first `period` defined values (convention 2). First value at `from + period - 1`.
 *
 * Written as `prev + k * (v - prev)` rather than `v*k + prev*(1-k)`: algebraically the
 * same, but a constant input then reproduces the seed exactly instead of drifting by an
 * ulp per bar.
 */
export function ema(values: Float64Array, period: number, from = 0): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const first = from + period - 1;
  if (first >= n) return out;

  const k = 2 / (period + 1);
  let prev = windowMean(values, from, period);
  out[first] = prev;
  for (let i = first + 1; i < n; i++) {
    prev += k * ((values[i] as number) - prev);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI (convention 3). First value at index `period`, seeded with the simple
 * mean of the first `period` gains and losses, then
 * `avg = (prevAvg * (period - 1) + current) / period`.
 *
 * `RSI = 100 * avgGain / (avgGain + avgLoss)` — identical to `100 - 100/(1 + RS)` but it
 * needs no division by `avgLoss`, so an all-gains window (loss 0) yields exactly 100 and
 * an all-losses window yields exactly 0 with no special case; the one genuinely
 * undefined case, no movement at all, is defined as 50.
 */
export function rsi(closes: Float64Array, period: number): Float64Array {
  const n = closes.length;
  const out = new Float64Array(n).fill(NaN);
  if (n <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d > 0) gainSum += d;
    else if (d < 0) lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const toRsi = (g: number, l: number): number => (g + l === 0 ? 50 : (100 * g) / (g + l));

  out[period] = toRsi(avgGain, avgLoss);
  const decay = period - 1;
  for (let i = period + 1; i < n; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    avgGain = (avgGain * decay + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * decay + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface MacdArrays {
  macd: Float64Array;
  signal: Float64Array;
  histogram: Float64Array;
}

/**
 * MACD = EMA(fast) - EMA(slow); signal = EMA(signalPeriod) of the MACD line seeded from
 * the SMA of its first `signalPeriod` DEFINED values; histogram = macd - signal
 * (convention 4). Requires `fast < slow`, which the caller has validated.
 */
export function macd(closes: Float64Array, fast: number, slow: number, signalPeriod: number): MacdArrays {
  const n = closes.length;
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = new Float64Array(n).fill(NaN);
  const start = slow - 1;
  for (let i = start; i < n; i++) line[i] = (fastEma[i] as number) - (slowEma[i] as number);

  const signal = ema(line, signalPeriod, start);
  const histogram = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const s = signal[i] as number;
    if (!Number.isNaN(s)) histogram[i] = (line[i] as number) - s;
  }
  return { macd: line, signal, histogram };
}
