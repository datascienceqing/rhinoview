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

export type IndicatorKind = 'sma' | 'ema' | 'rsi' | 'macd' | 'volume' | 'vpvr';

/** Where an indicator draws: on the price pane, or in its own pane below. */
export type IndicatorPlacement = 'overlay' | 'separate';

export const INDICATOR_PLACEMENT: Record<IndicatorKind, IndicatorPlacement> = {
  sma: 'overlay',
  ema: 'overlay',
  rsi: 'separate',
  macd: 'separate',
  // On the price pane like TradingView, but on its own scale in the bottom part of the pane.
  volume: 'overlay',
  // Drawn over the right side of the price pane; never on the price scale.
  vpvr: 'overlay',
};

export interface MovingAverageParams {
  period: number;
  /** Which bar field to average. Defaults to 'close'. */
  source?: 'open' | 'high' | 'low' | 'close';
}

export interface RsiParams {
  period: number;
}

/** Volume bars plus a simple moving average of the volume over `period` bars. */
export interface VolumeParams {
  period: number;
}

/**
 * Visible-range volume profile: the volume of the visible bars, bucketed by price into
 * `rows` horizontal rows. `widthPct` is the share of the pane width the largest row
 * takes; `valueAreaPct` is the share of the volume the highlighted value area covers.
 */
export interface VpvrParams {
  rows: number;
  widthPct: number;
  valueAreaPct: number;
}

export interface MacdParams {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export type IndicatorParams = MovingAverageParams | RsiParams | MacdParams | VolumeParams | VpvrParams;

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

/** A single named line. MACD yields three of these; Volume two ('volume', 'ma'); SMA/EMA/RSI one; VPVR none. */
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
  | 'NOT_FOUND' // a workspace entity (layout, watchlist) id that does not exist — never a symbol
  | 'CONFLICT' // a write carried a stale `revision`; refetch and reapply, do not blindly retry
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

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5 — capabilities, batch quotes, workspace (layouts + watchlists), fundamentals
// Frozen for Phase 5. Orchestrator-owned: report problems, never edit.
// ═══════════════════════════════════════════════════════════════════════════════

/** `GET /api/capabilities` — what the active providers can actually serve. */
export interface Capabilities {
  /** Subset of TIMEFRAMES the market-data provider serves. The UI disables the rest. */
  timeframes: Timeframe[];
  /** Market data is delayed; the UI must badge it. */
  delayed: boolean;
  /** Active market-data provider name, for diagnostics. Never contains any part of a key. */
  provider: string;
  /** Whether the fundamentals endpoints are served at all. When false, the UI hides the panel. */
  fundamentals: boolean;
}

// ───────────────────────────── Batch quotes ─────────────────────────────

/** Hard cap on symbols per `/api/quotes` request, and per watchlist. */
export const MAX_QUOTE_SYMBOLS = 50;

/**
 * `GET /api/quotes?symbols=AAPL,MSFT,...` — the watchlist's data source.
 *
 * PARTIAL SUCCESS IS NORMAL. One delisted or mistyped ticker must not blank the whole
 * watchlist, so an unknown symbol lands in `missing` and the request still succeeds.
 * Only a failure of the request as a whole (bad params, provider down, rate limited
 * on every symbol) is an `ok: false` envelope.
 */
export interface QuotesResponse {
  /** One per resolvable requested symbol, in request order, canonical symbol casing. */
  quotes: Snapshot[];
  /** Requested symbols that could not be resolved, exactly as the caller spelled them. */
  missing: string[];
  /** Symbols that resolved but whose quote fetch failed transiently; retry later. */
  failed: string[];
}

// ─────────────────────── Workspace: layouts and watchlists ───────────────────────

/** Opaque server-generated id. Clients never mint ids. */
export type EntityId = string;

/**
 * A named chart, as TradingView calls a saved "layout". The chart's ENTIRE visible
 * configuration lives here, including its indicators.
 *
 * Indicators belong to the layout, not to the symbol. Switching the symbol inside a
 * layout keeps its indicators; switching layouts swaps them. That is the TradingView
 * model, and it replaces the Phase 3 per-symbol localStorage persistence, which must
 * be migrated into the default layout on first load and then retired.
 */
export interface ChartLayout {
  id: EntityId;
  /** 1–64 chars after trimming. Unique among layouts, compared case-insensitively. */
  name: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  indicators: IndicatorConfig[];
  /**
   * Monotonic per entity, starting at 1. Every successful write increments it. A write
   * must carry the revision it was based on; a stale one gets CONFLICT (409). This is
   * what stops two open tabs from silently overwriting each other's edits.
   */
  revision: number;
  createdAt: UnixSeconds;
  updatedAt: UnixSeconds;
}

export interface Watchlist {
  id: EntityId;
  /** 1–64 chars after trimming. Unique among watchlists, compared case-insensitively. */
  name: string;
  /** Canonical symbols, no duplicates, user-chosen order, at most MAX_QUOTE_SYMBOLS. */
  symbols: string[];
  revision: number;
  createdAt: UnixSeconds;
  updatedAt: UnixSeconds;
}

export const MAX_LAYOUTS = 50;
export const MAX_WATCHLISTS = 50;
export const MAX_NAME_LENGTH = 64;

/** `GET /api/workspace` — everything the client needs on load, in one request. */
export interface Workspace {
  /** Never empty: the server guarantees at least one layout exists. */
  layouts: ChartLayout[];
  /** May be empty. */
  watchlists: Watchlist[];
  /** Always the id of an existing layout. */
  activeLayoutId: EntityId;
  /** The id of an existing watchlist, or null when there are none. */
  activeWatchlistId: EntityId | null;
}

/** Body of `POST /api/layouts`. Omitted fields take the server's defaults. */
export interface CreateLayoutBody {
  name: string;
  symbol?: string;
  timeframe?: Timeframe;
  chartType?: ChartType;
  indicators?: IndicatorConfig[];
}

/** Body of `PUT /api/layouts/:id`. Partial update; `revision` is required. */
export interface UpdateLayoutBody {
  revision: number;
  name?: string;
  symbol?: string;
  timeframe?: Timeframe;
  chartType?: ChartType;
  indicators?: IndicatorConfig[];
}

export interface CreateWatchlistBody {
  name: string;
  symbols?: string[];
}

export interface UpdateWatchlistBody {
  revision: number;
  name?: string;
  symbols?: string[];
}

/** Body of `PUT /api/workspace/active`. */
export interface SetActiveBody {
  activeLayoutId?: EntityId;
  activeWatchlistId?: EntityId | null;
}

// ───────────────────────────── Fundamentals ─────────────────────────────

export type StatementKind = 'income' | 'balance' | 'cashflow';
export type StatementPeriod = 'annual' | 'quarter';

/**
 * Company identity and description. Every field the provider may omit is nullable;
 * an omitted field is `null`, never `""`, never `0`, never a guess.
 */
export interface CompanyProfile {
  symbol: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  website: string | null;
  description: string | null;
  ceo: string | null;
  employees: number | null;
  ipoDate: string | null; // 'YYYY-MM-DD'
  /** Currency the listing TRADES in — not necessarily the currency it REPORTS in. */
  currency: string;
  marketCap: number | null;
}

/**
 * A curated set of trailing-twelve-month metrics. Curated deliberately: FMP returns
 * 100+ TTM fields and dumping them all is unreadable. Ratios are FRACTIONS, never
 * pre-multiplied — 0.4512 means 45.12%. Every field is nullable: a bank has no gross
 * margin, a company with losses has no meaningful P/E, and a missing value must render
 * as "—", never as 0.
 */
export interface KeyMetricsTTM {
  // Valuation
  peRatio: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  evToEbitda: number | null;
  pegRatio: number | null;
  // Profitability (fractions)
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  returnOnInvestedCapital: number | null;
  // Financial health
  debtToEquity: number | null;
  currentRatio: number | null;
  interestCoverage: number | null;
  // Per share, in the REPORTING currency
  epsDiluted: number | null;
  revenuePerShare: number | null;
  freeCashFlowPerShare: number | null;
  bookValuePerShare: number | null;
  // Dividend (fractions)
  dividendYield: number | null;
  payoutRatio: number | null;
}

export interface FinancialScores {
  /** 0–9. */
  piotroskiScore: number | null;
  altmanZScore: number | null;
}

export interface AnalystConsensus {
  targetHigh: number | null;
  targetLow: number | null;
  targetConsensus: number | null;
  targetMedian: number | null;
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
  /** Provider's summary label, e.g. "Buy". Null when absent. */
  consensus: string | null;
}

/** `GET /api/fundamentals/overview?symbol=` — the panel's headline, in one request. */
export interface FundamentalsOverview {
  profile: CompanyProfile;
  metrics: KeyMetricsTTM;
  scores: FinancialScores;
  analyst: AnalystConsensus;
  /** The currency the financial statements and per-share metrics are REPORTED in. */
  reportedCurrency: string;
  /** When the provider's data was fetched, for a "data as of" label. */
  asOf: UnixSeconds;
  /**
   * Sections the provider could not serve for this symbol (plan tier, no coverage).
   * Their fields are all null. The UI shows "not available" for these sections,
   * instead of a block of dashes that looks like a loading failure.
   * The overview succeeds when at least the profile is available.
   */
  unavailable: ('metrics' | 'scores' | 'analyst')[];
  /**
   * True when the issuer's "cost of revenue" is mostly interest expense: banks,
   * broker-dealers and card lenders. Its gross margin is then a lending spread, not a
   * gross margin, and the UI shows "NM" for it. Operating and net margin stay meaningful.
   * The provider decides from the income statement, not from the sector: FMP puts Visa
   * (interest 7% of cost of revenue) in the same industry as Capital One (43%).
   */
  grossMarginNotMeaningful: boolean;
}

/**
 * One reporting period of one statement. `lines` is a curated, ordered map of
 * line-item key → value in `reportedCurrency`, null when the line is absent for this
 * company (a bank has no "cost of revenue").
 */
export interface StatementRow {
  /** The issuer's fiscal year, e.g. 2026. NOT the calendar year — MSFT's FY2026 ends June 2026. */
  fiscalYear: number;
  /** 'FY' for annual rows; 'Q1'..'Q4' for quarterly rows. */
  fiscalPeriod: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4';
  /** Period end date, 'YYYY-MM-DD'. */
  periodEnd: string;
  /** Filing date, 'YYYY-MM-DD', or null when unknown. */
  filingDate: string | null;
  reportedCurrency: string;
  lines: Record<string, number | null>;
}

/** `GET /api/fundamentals/statements?symbol=&statement=&period=` */
export interface StatementsResponse {
  symbol: string;
  statement: StatementKind;
  period: StatementPeriod;
  /** Ordered list of line-item keys with display labels, in presentation order. */
  lineItems: { key: string; label: string }[];
  /** NEWEST period first. */
  rows: StatementRow[];
}

/** One earnings report. Estimates are null when the provider had none. */
export interface EarningsEvent {
  date: string; // 'YYYY-MM-DD'
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

/** Events per earnings response when the request has no `limit`. */
export const DEFAULT_EARNINGS_LIMIT = 40;
/** Largest `limit` the earnings endpoint accepts. */
export const MAX_EARNINGS_LIMIT = 400;

/**
 * `GET /api/fundamentals/earnings?symbol=&limit=` — NEWEST first; upcoming reports have null
 * actuals. At most `limit` events (default DEFAULT_EARNINGS_LIMIT). Fewer events than `limit`
 * means the provider has no more; exactly `limit` means there can be more ("Show more").
 */
export interface EarningsResponse {
  symbol: string;
  events: EarningsEvent[];
}
