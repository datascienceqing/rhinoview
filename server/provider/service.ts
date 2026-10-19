/**
 * MarketService — adapts a `MarketEngine` onto the contract's payload types and error
 * codes. Routes call this; it is the only thing that talks to the engine.
 *
 * Responsibilities, in order of a request's life:
 *   resolve symbol → cache lookup (bars only) → fault injection → engine call →
 *   error mapping → payload shaping.
 *
 * Fault injection sits behind the cache on purpose: a real upstream is only touched
 * (and can only rate-limit) on a miss, so a cache hit never fails.
 */
import { TIMEFRAMES } from '@shared/types';
import type {
  Bar,
  BarsResponse,
  IndicatorSeries,
  SearchResponse,
  Snapshot,
  Timeframe,
  UnixSeconds,
} from '@shared/types';
import { BarsCache, ttlSecondsForTimeframe } from '../cache/barsCache';
import type { BarsCacheKey } from '../cache/barsCache';
import { redact } from '../env';
import { UnknownSymbolError } from '../market/types';
import type { MarketEngine } from '../market/types';
import { ApiFailure, MESSAGES, mapEngineError } from './errors';
import { NO_FAULTS, createFaultInjector } from './faults';
import type { FaultInjector } from './faults';
import { computeIndicator } from './indicators';
import type { IndicatorRequest } from './indicators';

/**
 * Most bars any one request may return, per timeframe (CONTRACT "Request bounds").
 * The engine is synchronous, so a request blocks the event loop for as long as it
 * takes to build these. Measured on the synthetic engine, cold, all history, rotating
 * symbols (worst of 8): 1m/5m 10k bars ~40 ms, 15m 10k ~65 ms, 1h 5k ~75 ms, 4h 2k ~85 ms,
 * 1D 2k ~170 ms, 1W 500 ~230 ms (400 chosen: ~185 ms).
 * A 4h bar aggregates 240 minutes against a daily bar's 390, so the same 2,000-bar cap
 * costs half as much and still reaches ~5 years back at ~2 bars a session.
 * Daily is capped lowest because its per-bar cost is ~10x intraday's, and a weekly bar
 * costs ~5 daily ones when the engine's day memo is cold (2,400 weekly bars took ~900 ms cold),
 * so weekly is capped by work, not by how much history there is.
 */
export const BAR_CAPS: Record<Timeframe, number> = {
  '1m': 10_000,
  '5m': 10_000,
  '15m': 10_000,
  '1h': 5_000,
  '4h': 2_000,
  '1D': 2_000,
  '1W': 400,
};

/**
 * A `to` within this many seconds of now means "up to the present". Real clients
 * anchor at their own `nowSeconds()`, which is a little behind the server's clock by
 * the time the request lands (skew + latency, normally well under a second), so an
 * exact `to > now` test never fires. 120 s is generous for skew and slow links while
 * staying small next to the TTLs. The cost is that such a request may receive up to
 * 2 minutes more data than its `to` named; the newest bar is partial anyway.
 */
export const LIVE_SLACK_SECONDS = 120;

/** Bars of each timeframe in one full session (09:30-16:00), for sizing a window. */
const BARS_PER_SESSION: Record<Exclude<Timeframe, '1W'>, number> = { '1m': 390, '5m': 78, '15m': 26, '1h': 7, '4h': 2, '1D': 1 };
/** Lower bound on trading days per calendar day over a window of weeks (holidays, weekends). */
const MIN_TRADING_DAY_DENSITY = 0.55;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/**
 * Calendar seconds, counted back from `to`, that comfortably hold `cap` bars. This is
 * what lets us narrow the range BEFORE the engine sees it. It is deliberately generous
 * (the engine still clips to `cap` newest-first); if reality is sparser the response
 * just holds fewer bars and `truncated` tells the client to keep walking backwards.
 */
export function windowSeconds(tf: Timeframe, cap: number): number {
  if (tf === '1W') return (cap + 2) * WEEK_SECONDS;
  const tradingDays = Math.ceil(cap / BARS_PER_SESSION[tf]);
  return Math.ceil(tradingDays / MIN_TRADING_DAY_DENSITY) * DAY_SECONDS + WEEK_SECONDS;
}

/**
 * Longest span a bar of each timeframe can cover. Used only to decide whether the
 * newest bar could still be forming at `now` (CONTRACT guarantee 5a).
 */
const TIMEFRAME_SPAN_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1D': 86_400,
  '1W': 604_800,
};
/** Minute bars needed to rebuild a forming bar: a 1W bar holds at most ~5 sessions of 390. */
const LIVE_EDGE_MINUTE_LIMIT = 10_000;
/** The engine may return up to this many search hits before we filter and slice. */
const SEARCH_OVERFETCH = 50;

/**
 * Payload of `GET /api/capabilities`. `shared/types.ts` (frozen) has no named type for it
 * yet; the shape is exactly the one in docs/CONTRACT.md.
 */
export interface CapabilitiesPayload {
  timeframes: Timeframe[];
  delayed: boolean;
  provider: string;
}

export interface ServiceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MarketServiceDeps {
  engine: MarketEngine;
  faults?: FaultInjector;
  cache?: BarsCache;
  /** Current time in Unix seconds. Injectable so snapshot tests are deterministic. */
  now?: () => UnixSeconds;
  log?: ServiceLogger;
  /** Overrides BAR_CAPS for every timeframe. Tests shrink it to exercise truncation cheaply. */
  maxBars?: number;
  /** Provider name for `/api/capabilities`. A label for diagnostics: it must never be derived from a key. */
  provider?: string;
}

/**
 * The one place the system clock (milliseconds, by JS's definition) becomes Unix
 * seconds. This is not an upstream conversion — it only supplies `asOf` to the engine.
 */
const systemNowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000);

const noopLog: ServiceLogger = { warn: () => undefined };

export interface BarsRequest {
  symbol: string;
  timeframe: Timeframe;
  from: UnixSeconds;
  to: UnixSeconds;
  adjusted: boolean;
}

export class MarketService {
  private readonly engine: MarketEngine;
  private readonly faults: FaultInjector;
  private readonly cache: BarsCache;
  private readonly now: () => UnixSeconds;
  private readonly log: ServiceLogger;
  private readonly maxBars: number | undefined;
  private readonly provider: string;

  constructor(deps: MarketServiceDeps) {
    this.engine = deps.engine;
    this.faults = deps.faults ?? createFaultInjector(NO_FAULTS);
    this.cache = deps.cache ?? new BarsCache();
    this.now = deps.now ?? systemNowSeconds;
    this.log = deps.log ?? noopLog;
    this.maxBars = deps.maxBars;
    this.provider = deps.provider ?? 'custom';
  }

  /** What the active engine can serve, so the client can disable what would fail. */
  capabilities(): CapabilitiesPayload {
    const served = new Set<Timeframe>(this.engine.supportedTimeframes);
    return { timeframes: TIMEFRAMES.filter((tf) => served.has(tf)), delayed: this.engine.delayed, provider: this.provider };
  }

  async search(query: string, limit: number): Promise<SearchResponse> {
    const hits = await this.upstream(() => this.engine.searchSymbols(query, SEARCH_OVERFETCH));
    // Engine relevance order is preserved; filter then slice, never re-sort.
    const results = hits.filter((r) => r.active).slice(0, limit);
    return { query, results };
  }

  async bars(req: BarsRequest): Promise<BarsResponse> {
    this.requireTimeframe(req.timeframe);
    const symbol = await this.resolve(req.symbol);
    const now = this.now();
    const plan = this.plan(req, now);
    // Nothing in the requested range has happened (or completed) yet: a valid, successful, empty answer.
    if (!plan) return emptyBars(symbol, req);

    if (!plan.live) {
      const key = { symbol, timeframe: req.timeframe, from: req.from, to: req.to, adjusted: req.adjusted };
      const hit = this.cache.get(key);
      if (hit) return hit;
      const response = await this.fetchBars({ ...req, symbol, from: plan.from, to: plan.to }, now);
      // Narrowing dropped older range the caller asked for, which may hold more bars.
      if (plan.from > req.from) response.truncated = true;
      this.cache.set(key, response);
      return response;
    }

    // Up to the present. Keyed by `'now'` (so every near-present `to` shares one entry)
    // and by a snapped `from`: clients anchor `from = to - window`, which moves every
    // second, so an exact `from` would miss on every load. The entry covers [coverFrom, now],
    // a superset of any request that snaps to it; each request gets its own slice.
    const ttl = ttlSecondsForTimeframe(req.timeframe);
    const coverFrom = Math.floor(plan.from / ttl) * ttl;
    const key = { symbol, timeframe: req.timeframe, from: coverFrom, to: 'now' as const, adjusted: req.adjusted };
    const entry = this.cache.get(key) ?? (await this.fetchLive({ ...req, symbol, from: coverFrom, to: plan.to }, key, now));
    return sliceForRequest(entry, req.from, coverFrom);
  }

  private async fetchLive(req: BarsRequest, key: BarsCacheKey, now: UnixSeconds): Promise<BarsResponse> {
    const response = await this.fetchBars(req, now);
    this.cache.set(key, response);
    return response;
  }

  async snapshot(rawSymbol: string): Promise<Snapshot> {
    const symbol = await this.resolve(rawSymbol);
    const snap = await this.upstream(() => this.engine.getSnapshot(symbol, this.now()));
    // `delayed` comes from the engine's tier, never from a literal. `changePercent`
    // passes through untouched: it is a fraction, the client formats it.
    return { ...snap, delayed: this.engine.delayed };
  }

  /** ORACLE / DEBUG ONLY — see routes/index.ts. Uncached; computed from engine bars. */
  async indicator(
    req: Omit<BarsRequest, 'adjusted'> & { spec: IndicatorRequest },
  ): Promise<IndicatorSeries> {
    this.requireTimeframe(req.timeframe);
    const symbol = await this.resolve(req.symbol);
    const now = this.now();
    const full = { ...req, adjusted: true };
    const plan = this.plan(full, now);
    const bars = plan ? (await this.fetchBars({ ...full, symbol, from: plan.from, to: plan.to }, now)).bars : [];
    return computeIndicator(bars, req.spec);
  }

  /**
   * Decide what range the engine is actually asked for, or undefined if it is empty.
   *  - `to` is clamped to what has completed: now, or for 1m the last finished minute.
   *  - A `to` within LIVE_SLACK of now is "live" (see `bars`).
   *  - `from` is narrowed so no more than ~one cap's worth of range reaches the engine.
   */
  private plan(req: BarsRequest, now: UnixSeconds): { from: UnixSeconds; to: UnixSeconds; live: boolean } | undefined {
    const cutoff = req.timeframe === '1m' ? now - 60 : now;
    const live = req.to >= now - LIVE_SLACK_SECONDS;
    const to = live ? cutoff : req.to;
    if (to < req.from) return undefined;
    const from = Math.max(req.from, to - windowSeconds(req.timeframe, this.capFor(req.timeframe)));
    return { from, to, live };
  }

  /**
   * A timeframe outside the engine's list is UNAUTHORIZED: the contract defines that
   * code as covering a key that lacks the plan tier for this data. Checked before the
   * cache and before any upstream call, so a stale client costs nothing.
   */
  private requireTimeframe(tf: Timeframe): void {
    if (!this.engine.supportedTimeframes.includes(tf)) {
      throw new ApiFailure('UNAUTHORIZED', MESSAGES.timeframeUnsupported);
    }
  }

  private capFor(tf: Timeframe): number {
    return this.maxBars ?? BAR_CAPS[tf];
  }

  /** Resolve to the canonical symbol. The caller's string is passed through verbatim. */
  private async resolve(symbol: string): Promise<string> {
    let resolved;
    try {
      resolved = await this.engine.resolveSymbol(symbol);
    } catch (err) {
      throw this.fail(err);
    }
    if (!resolved) throw this.fail(new UnknownSymbolError(symbol));
    return resolved.symbol;
  }

  /** `req.from`/`req.to` must already be planned: clamped to `now` and narrowed to the cap. */
  private async fetchBars(req: BarsRequest, now: UnixSeconds): Promise<BarsResponse> {
    const result = await this.upstream(async () => {
      const r = await this.engine.getBars({
        symbol: req.symbol,
        timeframe: req.timeframe,
        from: req.from,
        to: req.to,
        adjusted: req.adjusted,
        limit: this.capFor(req.timeframe),
      });
      return { bars: await this.closeLiveEdge(normalizeBars(r.bars), req, now), truncated: r.truncated };
    });
    let bars = result.bars;
    let truncated = result.truncated;
    const cap = this.capFor(req.timeframe);
    if (bars.length > cap) {
      // The engine is asked for `limit` and should honour it. If one doesn't, clip here,
      // and clip the OLD end: truncation keeps the newest bars (CONTRACT guarantee 4).
      bars = bars.slice(bars.length - cap);
      truncated = true;
    }
    return {
      symbol: req.symbol,
      timeframe: req.timeframe,
      adjusted: req.adjusted,
      bars,
      truncated,
      cached: false,
    };
  }

  /**
   * Make the newest bar tell the truth about `now` (CONTRACT guarantee 5a).
   *
   * The engine has no clock, so a bar stamped in the past is still a whole-bucket
   * aggregate: today's 1D bar carries the close of a session that has not finished, and
   * on Wednesday the 1W bar carries Thursday and Friday. Handing that on would leak
   * future prices through a bar whose `time` looks innocent. Only the final bar can
   * straddle `now`, so it is rebuilt from the 1m bars that have actually occurred
   * (the engine guarantees buckets are exact aggregates of its minutes), and dropped if
   * none have, e.g. the midnight-stamped 1D bar during pre-market. A bar whose bucket
   * is fully past is returned untouched.
   *
   * "Elapsed" means COMPLETED minutes: a minute still in progress is excluded, not
   * returned whole, because the engine's atom is one minute and including it would leak
   * the rest of that minute. That is also what the engine's snapshot does, so the last
   * bar and `/api/snapshot` agree. A 1m request therefore ends at the last finished minute.
   */
  private async closeLiveEdge(bars: Bar[], req: BarsRequest, now: UnixSeconds): Promise<Bar[]> {
    // Last completed minute opens at or before now - 60. Defensive: the engine was already
    // given a clamped `to`, but nothing past the cutoff may ever leave this method.
    const cutoff = req.timeframe === '1m' ? now - 60 : now;
    let end = bars.length;
    while (end > 0 && (bars[end - 1]?.time ?? 0) > cutoff) end--;
    const head = end === bars.length ? bars : bars.slice(0, end);
    const tail = head.at(-1);
    if (!tail || req.timeframe === '1m' || tail.time + TIMEFRAME_SPAN_SECONDS[req.timeframe] <= now) return head;
    // A provider with no minute data (end-of-day feeds) cannot rebuild the forming bar;
    // asking it would turn every request that touches today into an UNAUTHORIZED failure.
    // Its newest bar is returned as the provider reports it, and it is the provider's
    // own aggregate of sessions that have occurred, so it contains no future data.
    if (!this.engine.supportedTimeframes.includes('1m')) return head;

    const minutes = (await this.engine.getBars({
      symbol: req.symbol,
      timeframe: '1m',
      from: tail.time,
      to: now - 60, // completed minutes only
      adjusted: req.adjusted,
      limit: LIVE_EDGE_MINUTE_LIMIT,
    })).bars;
    const rebuilt = aggregateMinutes(tail.time, minutes);
    const settled = head.slice(0, -1);
    if (!rebuilt) return settled; // bucket has not begun trading
    // Same volume means the bucket was already complete (e.g. after the close): keep
    // the engine's own bar, with its exact vwap, rather than a re-derived one.
    return rebuilt.volume === tail.volume ? head : [...settled, rebuilt];
  }

  /** Run one upstream-bound engine call: fault gate, then call, with errors mapped. */
  private async upstream<T>(call: () => T | Promise<T>): Promise<T> {
    try {
      await this.faults.gate();
      return await call();
    } catch (err) {
      throw this.fail(err);
    }
  }

  private fail(err: unknown): ApiFailure {
    const failure = mapEngineError(err);
    // UNKNOWN_SYMBOL is an ordinary caller outcome, not worth a log line.
    if (failure.code !== 'UNKNOWN_SYMBOL') {
      const raw = err instanceof Error ? err.message : String(err);
      this.log.warn({ code: failure.code, cause: redact(raw) }, 'engine call failed');
    }
    // The logged cause is redacted; the response message never contains it at all.
    return new ApiFailure(failure.code, redact(failure.message), failure.retryAfterSeconds);
  }
}

function emptyBars(symbol: string, req: BarsRequest): BarsResponse {
  return { symbol, timeframe: req.timeframe, adjusted: req.adjusted, bars: [], truncated: false, cached: false };
}

/**
 * A request's view of a cached live entry that covers [coverFrom, now]. The entry holds
 * the newest bars; the request wants only those at or after its own `from`.
 *
 * `truncated` is computed per request: when the entry was clipped by the cap, the
 * request is truncated iff it reaches back past the oldest bar kept; when it wasn't,
 * iff the request asked for range older than the entry covers (narrowing).
 */
export function sliceForRequest(entry: BarsResponse, wantFrom: UnixSeconds, coverFrom: UnixSeconds): BarsResponse {
  const oldest = entry.bars[0]?.time;
  const truncated = entry.truncated ? oldest !== undefined && wantFrom < oldest : wantFrom < coverFrom;
  let start = 0;
  while (start < entry.bars.length && (entry.bars[start]?.time ?? 0) < wantFrom) start++;
  return { ...entry, bars: start === 0 ? entry.bars : entry.bars.slice(start), truncated };
}

/** Fold ascending 1m bars into one bar stamped `time`; undefined when there are none. */
function aggregateMinutes(time: UnixSeconds, minutes: Bar[]): Bar | undefined {
  const first = minutes[0];
  const last = minutes.at(-1);
  if (!first || !last) return undefined;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let vwapNumerator = 0;
  let transactions: number | null = 0;
  let vwapKnown = true;
  for (const m of minutes) {
    high = Math.max(high, m.high);
    low = Math.min(low, m.low);
    volume += m.volume;
    if (m.vwap === null) vwapKnown = false;
    else vwapNumerator += m.vwap * m.volume;
    transactions = transactions === null || m.transactions === null ? null : transactions + m.transactions;
  }
  const vwap = vwapKnown && volume > 0 ? Math.round((vwapNumerator / volume) * 1e4) / 1e4 : null;
  return { time, open: first.open, high, low, close: last.close, volume, vwap, transactions };
}

/**
 * Contract guarantee: strictly increasing `time`, no duplicates. The engine promises
 * this already, so the common path is one O(n) scan and no copy; only a violation
 * (a future real client merging pages) pays for sort + de-dupe.
 */
export function normalizeBars(bars: Bar[]): Bar[] {
  let ordered = true;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (prev && cur && cur.time <= prev.time) {
      ordered = false;
      break;
    }
  }
  if (ordered) return bars;
  const byTime = new Map<number, Bar>();
  for (const b of bars) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
