/**
 * Financial Modeling Prep market engine (`DATA_PROVIDER=fmp`).
 *
 * WHAT THIS TIER CAN DO (measured, not read from docs):
 *   - daily bars, quotes, symbol search, profiles and splits work;
 *   - Starter serves 5min, 15min and 1hour intraday; 1min and the batch quote
 *     endpoints answer HTTP 402.
 * So this engine serves `5m`, `15m`, `1h`, `4h`, `1D` and `1W`. `1W` is built from daily bars
 * and `4h` from hourly bars rather than fetched, which makes engine invariant 2 (1W over 1D,
 * 4h over 1h) hold by construction.
 *
 * SEAM NOTE. `MarketEngine` (server/market/types.ts, frozen) is SYNCHRONOUS. A provider
 * that talks to the network cannot be. This class therefore implements
 * `AsyncMarketEngine`, the same interface with every method returning a Promise, and
 * does NOT satisfy `MarketEngine` as written. Plugging it into `MarketService` needs
 * the seam to allow `T | Promise<T>`; see the report that accompanies this change.
 */
import type { Bar, SearchResult, Snapshot, Timeframe, UnixSeconds } from '@shared/types';
import { SESSION_OPEN_SECOND, mondayOf, nyDayOf, nyWallToUnix, sessionMinutes, sessionOpenUnix } from '../calendar';
import { UnknownSymbolError } from '../types';
import type { EngineBarsRequest, EngineBarsResult, EngineSymbol, MarketEngine } from '../types';
import { UnsupportedRequestError, UpstreamUnauthorizedError } from '../../provider/errors';
import { FmpClient, FmpPaymentRequiredError } from './client';
import type { FmpClientOptions } from './client';
import { FMP_ROW_CAP, aggregateFourHour, aggregateWeekly, eodRowsToBars, intradayRowsToBars, snapshotFromQuote } from './convert';
import { eodResponseSchema, intradayResponseSchema, profileResponseSchema, quoteResponseSchema, searchResponseSchema } from './schemas';
import type { ProfileRow, SearchRow } from './schemas';
import { dateToNySeconds, dayNumberToDate } from './time';

/** `MarketEngine` with every method asynchronous: what a network-backed provider can honestly implement. */
export type AsyncMarketEngine = {
  [K in keyof MarketEngine]: MarketEngine[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : MarketEngine[K];
};

export interface FmpEngineOptions extends Omit<FmpClientOptions, 'apiKey'> {
  apiKey: string;
  /**
   * Report data as delayed. Defaults to TRUE, deliberately: see `delayed` below.
   * Set false only after measuring a quote timestamp that tracks the wall clock
   * during a session.
   */
  delayed?: boolean;
  now?: () => number;
}

/**
 * 1min is HTTP 402 on FMP Starter (measured), so it is not served.
 *
 * `4h` IS served, but it is FOLDED from `1hour` rows rather than fetched. FMP publishes a
 * `4hour` path; nobody has measured whether this tier answers it, and folding costs one
 * request we already know works and makes invariant 2 (4h over 1h) hold by construction.
 */
const SUPPORTED: readonly Timeframe[] = ['5m', '15m', '1h', '4h', '1D', '1W'];
const INTRADAY_PATH = { '5m': '5min', '15m': '15min', '1h': '1hour' } as const;
const INTRADAY_SPAN_SECONDS = { '5m': 300, '15m': 900, '1h': 3600 } as const;
/** Largest Unix time we will turn into a date string (2100-01-01); the proxy clamps to now long before. */
const MAX_UNIX = 4_102_444_800;
/** Tickers we are willing to send upstream. Anything else cannot be a listed symbol. */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.^-]{0,15}$/;

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_TTL_MS = 5 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const SEARCH_ASK_MAX = 50;

interface Cached<T> {
  value: T;
  expires: number;
}

export class FmpEngine implements AsyncMarketEngine {
  readonly supportedTimeframes: readonly Timeframe[] = SUPPORTED;

  /**
   * HOW `delayed` IS DECIDED. It is `true` unless the operator says otherwise, because:
   *   1. Starter serves 5min/15min/1hour intraday, but nobody has measured its lag
   *      during market hours, so there is no verified real-time feed behind it.
   *      (Written when the key was on the free tier, where intraday was all HTTP 402.)
   *   2. The one thing `quote` gives us to test freshness is its `timestamp`. Measured
   *      after the close it was 16:00:01 ET, i.e. the session's final print, which says
   *      nothing about lag. The measurement that would settle it needs a quote taken
   *      while the market is open, and none was possible during development.
   * The two possible errors are not symmetric: calling live data delayed shows a
   * badge that is harmless, calling delayed data live is the one factual error this
   * app must not make. Absent proof of liveness, report delayed.
   */
  readonly delayed: boolean;

  private readonly client: FmpClient;
  private readonly now: () => number;
  private readonly profiles = new Map<string, Cached<EngineSymbol | null>>();
  private readonly searches = new Map<string, Cached<SearchResult[]>>();

  constructor(opts: FmpEngineOptions) {
    this.client = new FmpClient(opts);
    this.delayed = opts.delayed ?? true;
    this.now = opts.now ?? Date.now;
  }

  async resolveSymbol(symbol: string): Promise<EngineSymbol | undefined> {
    const key = symbol.trim().toUpperCase();
    if (!SYMBOL_RE.test(key)) return undefined;

    const hit = this.profiles.get(key);
    if (hit && hit.expires > this.now()) return hit.value ?? undefined;

    let row: ProfileRow | undefined;
    try {
      row = profileResponseSchema.parse(await this.client.getJson('/profile', { symbol: key }))[0];
    } catch (err) {
      // On this tier a restricted symbol and an unknown one are indistinguishable (both 402).
      if (!(err instanceof FmpPaymentRequiredError && err.scope === 'symbol')) throw err;
    }

    const resolved = row ? toEngineSymbol(row) : null;
    this.profiles.set(key, { value: resolved, expires: this.now() + (resolved ? PROFILE_TTL_MS : UNKNOWN_TTL_MS) });
    // Cache under the canonical form too, so "aapl" and "AAPL" share one entry.
    if (resolved) this.profiles.set(resolved.symbol, { value: resolved, expires: this.now() + PROFILE_TTL_MS });
    return resolved ?? undefined;
  }

  async searchSymbols(query: string, limit: number): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q || !(limit >= 1)) return [];
    const n = Math.floor(limit);
    const cacheKey = `${q.toLowerCase()}|${n}`;
    const hit = this.searches.get(cacheKey);
    if (hit && hit.expires > this.now()) return hit.value;

    // Over-ask upstream: rows we filter out below must not leave the caller short.
    const ask = Math.min(SEARCH_ASK_MAX, n * 3);
    const bySymbol = await this.searchRows('/search-symbol', q, ask);
    // `search-symbol` matches TICKERS only ("apple" finds nothing). Company names need
    // `search-name`, so fall through to it only when tickers did not fill the request.
    const byName = bySymbol.length < n ? await this.searchRows('/search-name', q, ask) : [];

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const r of [...bySymbol, ...byName]) {
      const symbol = r.symbol.toUpperCase();
      if (seen.has(symbol) || !isUsListing(r)) continue;
      seen.add(symbol);
      results.push({
        symbol,
        name: r.name ?? r.symbol,
        exchange: r.exchange,
        // Neither endpoint says what kind of security a row is. Null, not a guess.
        type: null,
        // Always present in measured responses. USD is the fallback for the one missing
        // field a non-nullable `SearchResult.currency` forces us to fill.
        currency: r.currency ?? 'USD',
        // Neither endpoint has an "inactive" flag; FMP lists tradable symbols.
        active: true,
      });
      if (results.length === n) break;
    }
    // FMP's relevance order is kept (ticker matches, then name matches); the seam
    // additionally wants an exact ticker first, so lift that one row without disturbing
    // the rest (stable partition).
    const exact = q.toUpperCase();
    const ordered = [...results.filter((r) => r.symbol === exact), ...results.filter((r) => r.symbol !== exact)];

    if (this.searches.size >= SEARCH_CACHE_MAX) {
      const oldest = this.searches.keys().next();
      if (!oldest.done) this.searches.delete(oldest.value);
    }
    this.searches.set(cacheKey, { value: ordered, expires: this.now() + SEARCH_TTL_MS });
    return ordered;
  }

  private async searchRows(path: '/search-symbol' | '/search-name', query: string, limit: number): Promise<SearchRow[]> {
    return searchResponseSchema.parse(await this.client.getJson(path, { query, limit }));
  }

  async getBars(req: EngineBarsRequest): Promise<EngineBarsResult> {
    // The proxy checks this first and answers UNAUTHORIZED; throwing the same class here
    // keeps a direct caller honest too.
    if (!this.supportedTimeframes.includes(req.timeframe)) throw new UpstreamUnauthorizedError();
    // FMP has only the split-adjusted series. See the report: reconstructing "raw" prices
    // from /splits would be approximate, so the honest answer is a refusal.
    if (!req.adjusted) throw new UnsupportedRequestError();
    if (!Number.isFinite(req.from) || !Number.isFinite(req.to)) throw new RangeError('from/to must be finite');
    if (!Number.isFinite(req.limit) || req.limit < 1) throw new RangeError('limit must be >= 1');
    const limit = Math.floor(req.limit);
    const from = Math.max(0, req.from);
    const to = Math.min(req.to, MAX_UNIX);
    if (to < from) return { bars: [], truncated: false };

    if (req.timeframe === '4h') return this.getFourHourBars(req, from, to, limit);
    if (req.timeframe === '5m' || req.timeframe === '15m' || req.timeframe === '1h') {
      return this.getIntradayBars(req, from, to, limit);
    }

    const weekly = req.timeframe === '1W';
    const fromDay = nyDayOf(from);
    const toDay = nyDayOf(to);
    // A weekly bar is stamped on its Monday but aggregates the whole week, so fetch through
    // that week's Sunday even when `to` lands mid-week: the same whole-bucket aggregate the
    // synthetic engine returns. Days that have not happened yet simply are not in the answer.
    const lastDay = weekly ? mondayOf(toDay) + 6 : toDay;

    const rows = eodResponseSchema.parse(
      await this.client.getJson('/historical-price-eod/full', {
        symbol: req.symbol,
        from: dayNumberToDate(fromDay),
        to: dayNumberToDate(lastDay),
      }),
    );
    // Exactly the row cap means FMP clipped the OLD end (newest rows are kept).
    const clipped = rows.length >= FMP_ROW_CAP;
    let bars = eodRowsToBars(rows);

    if (weekly) {
      bars = aggregateWeekly(bars);
      // When clipped, the oldest week was cut mid-week and its open/volume are partial.
      // Drop it: the client's next request, ending just before the oldest bar returned,
      // fetches it whole.
      if (clipped) bars = bars.slice(1);
    }
    // Inclusive range on bar time (CONTRACT guarantee 5). For weekly this excludes the
    // week that straddles `from`, as the synthetic engine does.
    bars = bars.filter((b) => b.time >= from && b.time <= to);

    let truncated = clipped;
    if (bars.length > limit) {
      bars = bars.slice(bars.length - limit); // keep the NEWEST `limit` bars
      truncated = true;
    }
    return { bars, truncated };
  }

  /**
   * Intraday bars. FMP keeps the NEWEST rows when it clips (5min: 624 rows per request,
   * measured), so a clipped answer is missing its OLD end. Row caps for 15min and 1hour are
   * not measured, so two rules cover all three: `missesWholeSession` and
   * `startsAfterFirstExpectedBar` below. The client then continues from the oldest bar.
   * (A "more than one session" rule lost exactly one whole session silently.)
   */
  private async getIntradayBars(req: EngineBarsRequest, from: number, to: number, limit: number): Promise<EngineBarsResult> {
    const timeframe = req.timeframe as keyof typeof INTRADAY_PATH;
    const fromDay = nyDayOf(from);
    const rows = intradayResponseSchema.parse(
      await this.client.getJson(`/historical-chart/${INTRADAY_PATH[timeframe]}`, {
        symbol: req.symbol,
        from: dayNumberToDate(fromDay),
        to: dayNumberToDate(nyDayOf(to)),
      }),
    );
    // Whole NY days come back; the range is inclusive on bar time (CONTRACT guarantee 5).
    let bars = intradayRowsToBars(rows).filter((b) => b.time >= from && b.time <= to);

    let truncated =
      missesWholeSession(bars, from, fromDay) || startsAfterFirstExpectedBar(bars, from, INTRADAY_SPAN_SECONDS[timeframe]);
    if (bars.length > limit) {
      bars = bars.slice(bars.length - limit); // keep the NEWEST `limit` bars
      truncated = true;
    }
    return { bars, truncated };
  }

  /**
   * 4h bars, FOLDED from `1hour` rows (see SUPPORTED). One request, and invariant 2 holds
   * by construction.
   *
   * The hourly series is filtered at the LOWER end only. A 4h bucket must aggregate its
   * whole set of children to be the same whole-bucket aggregate the synthetic engine
   * returns, so clipping at `to` would make the newest bar partial; the route layer has
   * already clamped `to` to now. The lower filter is safe because no child of a kept
   * bucket is older than the bucket itself.
   *
   * Truncation uses the same two rules as the fetched timeframes, but on the hourly
   * series, since that is what FMP actually sent. The two are reported separately here
   * because only the second one makes the oldest BUCKET partial: a whole missing session
   * before the oldest day leaves that day's buckets intact, while a clip inside the
   * oldest day costs its first bucket its open and part of its volume.
   */
  private async getFourHourBars(req: EngineBarsRequest, from: number, to: number, limit: number): Promise<EngineBarsResult> {
    const fromDay = nyDayOf(from);
    const rows = intradayResponseSchema.parse(
      await this.client.getJson(`/historical-chart/${INTRADAY_PATH['1h']}`, {
        symbol: req.symbol,
        from: dayNumberToDate(fromDay),
        to: dayNumberToDate(nyDayOf(to)),
      }),
    );
    const hourly = intradayRowsToBars(rows).filter((b) => b.time >= from);
    const partialOldest = startsAfterFirstExpectedBar(hourly, from, INTRADAY_SPAN_SECONDS['1h']);
    let truncated = missesWholeSession(hourly, from, fromDay) || partialOldest;

    let bars = aggregateFourHour(hourly);
    // The client's next request, ending just before the oldest bar returned, fetches the
    // dropped bucket whole. Exactly what the weekly path does with a clipped first week.
    if (partialOldest) bars = bars.slice(1);
    bars = bars.filter((b) => b.time >= from && b.time <= to);

    if (bars.length > limit) {
      bars = bars.slice(bars.length - limit); // keep the NEWEST `limit` bars
      truncated = true;
    }
    return { bars, truncated };
  }

  async getSnapshot(symbol: string, _asOf: UnixSeconds): Promise<Snapshot> {
    const row = quoteResponseSchema.parse(await this.client.getJson('/quote', { symbol: symbol.trim().toUpperCase() }))[0];
    if (!row) throw new UnknownSymbolError(symbol);
    return snapshotFromQuote(row, this.delayed);
  }
}

/**
 * Truncation rule 1: a trading session that ends after `from` lies entirely before the
 * oldest bar's NY day, i.e. a session we should have data for and got none. A session that
 * closed at or before `from` does not count. Weekends, holidays and early closes follow
 * `../calendar`.
 */
function missesWholeSession(bars: readonly Bar[], from: number, fromDay: number): boolean {
  const oldest = bars[0];
  if (!oldest) return false;
  const oldestDay = nyDayOf(oldest.time);
  for (let d = fromDay; d < oldestDay; d++) {
    const minutes = sessionMinutes(d);
    if (minutes > 0 && nyWallToUnix(d, SESSION_OPEN_SECOND + minutes * 60) > from) return true;
  }
  return false;
}

/**
 * Truncation rule 2: FMP clipped INSIDE the oldest bar's day. The first expected bar of
 * that day (the later of `from` and the session open) is missing, i.e. the oldest bar
 * starts a whole bar or more after it. A bar that merely starts after `from` within its
 * own span (from = 10:02, first 5m bar 10:05) is not a gap.
 */
function startsAfterFirstExpectedBar(bars: readonly Bar[], from: number, span: number): boolean {
  const oldest = bars[0];
  if (!oldest) return false;
  const oldestDay = nyDayOf(oldest.time);
  if (sessionMinutes(oldestDay) === 0) return false;
  return oldest.time >= Math.max(from, sessionOpenUnix(oldestDay)) + span;
}

/**
 * This app charts US equities on a New York calendar, and FMP's name search returns
 * every listing in the world (measured: "apple" -> AAPL.MX, AAPL.TO, AAPL.DE, ...) plus
 * crypto pairs. Keep USD-quoted, non-crypto, non-FX rows; the others would only produce
 * a symbol whose bars cannot be fetched or whose sessions are not NYSE's.
 */
function isUsListing(r: SearchRow): boolean {
  return (r.currency ?? 'USD') === 'USD' && r.exchange !== 'CRYPTO' && r.exchange !== 'FOREX';
}

function toEngineSymbol(row: ProfileRow): EngineSymbol {
  const ipo = row.ipoDate ? dateToNySeconds(row.ipoDate) : undefined;
  return {
    symbol: row.symbol.toUpperCase(),
    name: row.companyName ?? row.symbol,
    exchange: row.exchange ?? '',
    type: row.isEtf ? 'ETF' : row.isFund ? 'FUND' : row.isAdr ? 'ADR' : 'CS',
    currency: row.currency ?? 'USD',
    // Informational only: FMP's own data decides what bars exist, we filter nothing on this.
    listedAt: ipo ?? 0,
  };
}

