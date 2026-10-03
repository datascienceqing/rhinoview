/**
 * Financial Modeling Prep market engine (`DATA_PROVIDER=fmp`).
 *
 * WHAT THIS TIER CAN DO (measured against the free-trial key, not read from docs):
 *   - daily bars, quotes, symbol search, profiles and splits work;
 *   - every intraday endpoint and `batch-quote-short` answer HTTP 402.
 * So this engine serves `1D` and `1W` only. `1W` is built here from daily bars rather
 * than fetched, which makes engine invariant 2 (1W over 1D) hold by construction.
 *
 * SEAM NOTE. `MarketEngine` (server/market/types.ts, frozen) is SYNCHRONOUS. A provider
 * that talks to the network cannot be. This class therefore implements
 * `AsyncMarketEngine`, the same interface with every method returning a Promise, and
 * does NOT satisfy `MarketEngine` as written. Plugging it into `MarketService` needs
 * the seam to allow `T | Promise<T>`; see the report that accompanies this change.
 */
import type { SearchResult, Snapshot, Timeframe, UnixSeconds } from '@shared/types';
import { mondayOf, nyDayOf } from '../calendar';
import { UnknownSymbolError } from '../types';
import type { EngineBarsRequest, EngineBarsResult, EngineSymbol, MarketEngine } from '../types';
import { UnsupportedRequestError, UpstreamUnauthorizedError } from '../../provider/errors';
import { FmpClient, FmpPaymentRequiredError } from './client';
import type { FmpClientOptions } from './client';
import { FMP_ROW_CAP, aggregateWeekly, eodRowsToBars, snapshotFromQuote } from './convert';
import { eodResponseSchema, profileResponseSchema, quoteResponseSchema, searchResponseSchema } from './schemas';
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

const SUPPORTED: readonly Timeframe[] = ['1D', '1W'];
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
   *   1. This key cannot read any intraday endpoint (all HTTP 402), so there is no
   *      real-time-quality feed behind it that we could have verified.
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

  async getSnapshot(symbol: string, _asOf: UnixSeconds): Promise<Snapshot> {
    const row = quoteResponseSchema.parse(await this.client.getJson('/quote', { symbol: symbol.trim().toUpperCase() }))[0];
    if (!row) throw new UnknownSymbolError(symbol);
    return snapshotFromQuote(row, this.delayed);
  }
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

