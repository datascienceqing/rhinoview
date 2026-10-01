/**
 * Response cache for /api/bars.
 *
 * Successes only: the only way to put something in is `set(key, BarsResponse)`, so an
 * error can't be cached by construction. A cached 429 would outlive the rate-limit
 * window and turn a transient failure into a persistent one.
 *
 * Sizing is by SUMMED BAR COUNT, not entry count. The cost of a response is its live
 * `Bar` objects (measured ~180 B each, not JSON bytes), so 200 entries of 50,000 bars
 * was ~1.5 GB. 250,000 bars is ~45 MB: a few dozen maximum-size entries or hundreds of
 * typical ones. A single response larger than the whole budget is simply not cached.
 * TTL is per entry: intraday data goes stale quickly, daily/weekly barely moves.
 */
import { LRUCache } from 'lru-cache';
import type { BarsResponse, Timeframe } from '@shared/types';
import { isIntraday } from '@shared/types';

export const INTRADAY_TTL_MS = 60_000;
export const DAILY_TTL_MS = 600_000;
export const DEFAULT_MAX_CACHED_BARS = 250_000;

export interface BarsCacheKey {
  /** Canonical symbol as resolved by the engine, so `aapl` and `AAPL` share an entry. */
  symbol: string;
  timeframe: Timeframe;
  from: number;
  /**
   * The range end, or `'now'` when the caller asked for data up to the present. Every
   * such `to` resolves to the same data, so they share one entry (see MarketService).
   */
  to: number | 'now';
  adjusted: boolean;
}

export function barsCacheKey(k: BarsCacheKey): string {
  return `${k.symbol}|${k.timeframe}|${k.from}|${k.to}|${k.adjusted}`;
}

export function ttlForTimeframe(tf: Timeframe): number {
  return isIntraday(tf) ? INTRADAY_TTL_MS : DAILY_TTL_MS;
}

/** The TTL, in seconds, entries of this timeframe live for. */
export const ttlSecondsForTimeframe = (tf: Timeframe): number => ttlForTimeframe(tf) / 1000;

export interface BarsCacheOptions {
  /** Ceiling on the total number of bars held across all entries. */
  maxBars?: number;
  /** Test seam: a monotonic millisecond clock for TTL expiry. Not for production use. */
  clock?: { now: () => number };
}

export class BarsCache {
  private readonly lru: LRUCache<string, BarsResponse>;

  constructor(opts: BarsCacheOptions = {}) {
    this.lru = new LRUCache<string, BarsResponse>({
      maxSize: opts.maxBars ?? DEFAULT_MAX_CACHED_BARS,
      // Every entry costs at least 1 so empty responses still count toward the bound.
      sizeCalculation: (v) => Math.max(1, v.bars.length),
      // lru-cache debounces its clock reads by 1ms of real time; an injected clock must be read every time.
      ...(opts.clock ? { perf: opts.clock, ttlResolution: 0 } : {}),
    });
  }

  /** A hit, flagged `cached: true`. The stored entry itself is never mutated. */
  get(key: BarsCacheKey): BarsResponse | undefined {
    const hit = this.lru.get(barsCacheKey(key));
    return hit ? { ...hit, cached: true } : undefined;
  }

  /** Store a successful response. Always stored with `cached: false`. */
  set(key: BarsCacheKey, response: BarsResponse): void {
    this.lru.set(barsCacheKey(key), { ...response, cached: false }, { ttl: ttlForTimeframe(key.timeframe) });
  }

  get size(): number {
    return this.lru.size;
  }

  /** Total bars currently held. */
  get totalBars(): number {
    return this.lru.calculatedSize;
  }
}
