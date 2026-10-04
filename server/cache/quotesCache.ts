/**
 * Quote cache for /api/quotes, shared by every caller of one server.
 *
 * Successes only: the only way in is `set(symbol, Snapshot)`, so a failure cannot be
 * cached by construction (a cached 429 would outlive the rate-limit window). TTL is 15 s,
 * so two watchlists that share a symbol fetch it once per window (CONTRACT, Phase 5).
 * Bounded, because the key space is whatever strings callers send.
 */
import { LRUCache } from 'lru-cache';
import type { Snapshot } from '@shared/types';

export const QUOTE_TTL_MS = 15_000;
export const QUOTE_CACHE_MAX_ENTRIES = 1_000;

export class QuotesCache {
  private readonly lru: LRUCache<string, Snapshot>;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.lru = new LRUCache<string, Snapshot>({
      max: opts.maxEntries ?? QUOTE_CACHE_MAX_ENTRIES,
      ttl: opts.ttlMs ?? QUOTE_TTL_MS,
      // Read the clock on every call (the default caches it for 1 ms), so an injected clock is exact.
      ttlResolution: 0,
      // Injectable clock so TTL tests need no real waiting.
      ...(opts.now ? { perf: { now: opts.now } } : {}),
    });
  }

  /** Keys are case-insensitive: callers pass any spelling. */
  get(symbol: string): Snapshot | undefined {
    return this.lru.get(symbol.toUpperCase());
  }

  set(symbol: string, snapshot: Snapshot): void {
    this.lru.set(symbol.toUpperCase(), snapshot);
  }
}
