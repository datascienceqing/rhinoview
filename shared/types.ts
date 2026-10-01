/**
 * SHARED CONTRACT TYPES — single source of truth for the client/proxy boundary.
 *
 * ORCHESTRATOR-OWNED. Workers must NOT edit this file. If you believe a type is
 * wrong or missing, stop and report it rather than changing it: both sides of the
 * boundary are built against this file in parallel, and an unilateral edit here
 * silently breaks the other worker.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * TIME IS UNIX **SECONDS**, UTC, EVERYWHERE IN THIS CONTRACT.
 *
 * Upstream (massive.com) returns `t` in Unix MILLISECONDS. The proxy divides by
 * 1000 exactly once, at the upstream boundary in `server/massive/`. Nothing
 * downstream of that — no route, no client module, no indicator — ever sees
 * milliseconds. lightweight-charts' `UTCTimestamp` is also seconds, so a Bar's
 * `time` is directly assignable to a series data point.
 *
 * If you find yourself writing `/ 1000` or `* 1000` anywhere outside
 * `server/massive/`, something has gone wrong upstream of you.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Unix timestamp in SECONDS (UTC). Directly compatible with lightweight-charts' UTCTimestamp. */
export type UnixSeconds = number;

/** Timeframes the UI exposes. The proxy owns the mapping to upstream multiplier/timespan. */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D' | '1W';

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '1D', '1W'] as const;

/** True for timeframes finer than one day — drives session gaps and axis formatting. */
export function isIntraday(tf: Timeframe): boolean {
  return tf === '1m' || tf === '5m' || tf === '15m' || tf === '1h';
}

/**
 * One OHLCV bar. Field names are deliberately spelled out rather than mirroring
 * upstream's single-letter keys: the proxy translates, so client code reads clearly.
 */
export interface Bar {
  /** Bar open time, Unix SECONDS, UTC. */
  time: UnixSeconds;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price. Upstream may omit it; null when absent. */
  vwap: number | null;
  /** Number of trades in the bar. Upstream may omit it; null when absent. */
  transactions: number | null;
}

/** A tradable symbol as returned by search. */
export interface SearchResult {
  /** Ticker symbol, e.g. "AAPL". Case-sensitive upstream — pass through unchanged. */
  symbol: string;
  name: string;
  /** Primary exchange code, e.g. "XNAS". Null when upstream does not report one. */
  exchange: string | null;
  /** e.g. "CS" (common stock), "ETF". Null when unknown. */
  type: string | null;
  currency: string;
  active: boolean;
}

/** Current/last-session state for a single symbol, for the header readout. */
export interface Snapshot {
  symbol: string;
  /** Last trade price. Null outside of any session with no recorded trade. */
  price: number | null;
  /** Absolute change vs previous close. */
  change: number | null;
  /** Fractional change vs previous close — 0.0123 means +1.23%. NOT pre-multiplied. */
  changePercent: number | null;
  previousClose: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  /** When upstream computed this, Unix SECONDS. */
  updated: UnixSeconds | null;
  /**
   * True when the key's plan tier serves delayed (typically 15-minute) data.
   * The UI must badge delayed data rather than implying it is live.
   */
  delayed: boolean;
}

// ───────────────────────────── Indicators ─────────────────────────────

export type IndicatorKind = 'sma' | 'ema' | 'rsi' | 'macd';

/** Where an indicator draws: on the price pane, or in its own pane below. */
export type IndicatorPlacement = 'overlay' | 'separate';

export const INDICATOR_PLACEMENT: Record<IndicatorKind, IndicatorPlacement> = {
  sma: 'overlay',
  ema: 'overlay',
  rsi: 'separate',
  macd: 'separate',
};

export interface MovingAverageParams {
  period: number;
  /** Which bar field to average. Defaults to 'close'. */
  source?: 'open' | 'high' | 'low' | 'close';
}

export interface RsiParams {
  period: number;
}

export interface MacdParams {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export type IndicatorParams = MovingAverageParams | RsiParams | MacdParams;

/**
 * One point of a computed indicator line.
 *
 * `value` is `null` during the warmup window — the leading bars for which the
 * indicator is mathematically undefined. It is NEVER 0 for "no value": a zero
 * draws a real line at zero and misleads the reader. Renderers must either skip
 * null points or use lightweight-charts' whitespace-data behaviour.
 */
export interface IndicatorPoint {
  time: UnixSeconds;
  value: number | null;
}

/** A single named line. MACD yields three of these; SMA/EMA/RSI yield one. */
export interface IndicatorLine {
  /** Stable key within the indicator, e.g. 'macd' | 'signal' | 'histogram' | 'value'. */
  key: string;
  /** Human label for the legend, e.g. "MACD (12,26,9)". */
  label: string;
  points: IndicatorPoint[];
}

export interface IndicatorSeries {
  kind: IndicatorKind;
  placement: IndicatorPlacement;
  params: IndicatorParams;
  lines: IndicatorLine[];
  /**
   * Count of leading bars with no defined value. Callers can assert that
   * `lines[*].points[i].value === null` for all `i < warmup`.
   */
  warmup: number;
}

// ───────────────────────── Transport envelopes ─────────────────────────

/** Machine-readable error codes. The UI switches on these, never on message text. */
export type ApiErrorCode =
  | 'BAD_REQUEST' // caller sent invalid params; do not retry unchanged
  | 'UNKNOWN_SYMBOL' // symbol not found upstream
  | 'NO_DATA' // valid request, genuinely empty result (e.g. pre-IPO range)
  | 'RATE_LIMITED' // upstream 429; `retryAfterSeconds` may be set
  | 'UPSTREAM_ERROR' // upstream 5xx or malformed response
  | 'UPSTREAM_TIMEOUT'
  | 'UNAUTHORIZED' // API key missing, invalid, or lacks the plan tier for this data
  | 'INTERNAL';

export interface ApiError {
  code: ApiErrorCode;
  /** Safe to show a user. Must never contain the API key or a raw upstream URL. */
  message: string;
  /** Present on RATE_LIMITED when upstream supplied a Retry-After. */
  retryAfterSeconds?: number;
}

/** Every proxy endpoint returns this envelope, including on error. HTTP status still reflects the outcome. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// ───────────────────── Request / response shapes ─────────────────────

export interface BarsQuery {
  symbol: string;
  timeframe: Timeframe;
  /** Inclusive range start, Unix SECONDS. */
  from: UnixSeconds;
  /** Inclusive range end, Unix SECONDS. */
  to: UnixSeconds;
  /** Split/dividend adjusted. Defaults to true. */
  adjusted?: boolean;
}

export interface BarsResponse {
  symbol: string;
  timeframe: Timeframe;
  adjusted: boolean;
  /** Ascending by `time`, strictly increasing, no duplicates. Guaranteed by the proxy. */
  bars: Bar[];
  /**
   * True when the proxy stopped before exhausting the requested range because it
   * hit its page cap. The client should treat the oldest bar as a partial edge
   * and request further history from there rather than assuming the range is complete.
   */
  truncated: boolean;
  /** Whether this response was served from the proxy's cache. Diagnostics only. */
  cached: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

/** Indicator endpoint: ORACLE / DEBUG ONLY. See docs/CONTRACT.md. */
export interface IndicatorQuery {
  symbol: string;
  timeframe: Timeframe;
  kind: IndicatorKind;
  params: IndicatorParams;
  from: UnixSeconds;
  to: UnixSeconds;
}

// ───────────────────────── Client-side config ─────────────────────────

/** A user-configured indicator instance on the chart. Persisted to localStorage. */
export interface IndicatorConfig {
  /** Stable client-generated id; distinguishes two SMAs with different periods. */
  id: string;
  kind: IndicatorKind;
  params: IndicatorParams;
  /** CSS color for the primary line. */
  color: string;
  visible: boolean;
}

export type ChartType = 'candlestick' | 'line' | 'area';
