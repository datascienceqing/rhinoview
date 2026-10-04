/**
 * Caching wrapper for any `FundamentalsProvider` (invariant 9).
 *
 * TTLs: overview and statements 6 hours; earnings 1 hour, because an upcoming report
 * gets its actual values on the day. SUCCESSES ONLY: a rejected call is never stored, so
 * a 429 or a 402 cannot outlive its cause. Concurrent identical calls share one upstream
 * request, and a shared failure is dropped from the in-flight map as soon as it settles.
 *
 * The key is the symbol as the caller spelled it, trimmed and upper-cased, so `aapl` and
 * `AAPL` share an entry. Entries are objects handed out by reference; callers must not
 * mutate them (the routes only serialise them).
 */
import type {
  EarningsResponse,
  FundamentalsOverview,
  StatementKind,
  StatementPeriod,
  StatementsResponse,
} from '@shared/types';
import type { FundamentalsProvider } from './types';

export const OVERVIEW_TTL_MS = 6 * 60 * 60 * 1000;
export const STATEMENTS_TTL_MS = 6 * 60 * 60 * 1000;
export const EARNINGS_TTL_MS = 60 * 60 * 1000;
/** Bounds memory: a long-running server must not hold every symbol ever asked for. */
export const MAX_CACHE_ENTRIES = 500;

interface Entry {
  value: unknown;
  expires: number;
}

export class CachedFundamentalsProvider implements FundamentalsProvider {
  readonly available: boolean;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly inner: FundamentalsProvider,
    private readonly now: () => number = Date.now,
  ) {
    this.available = inner.available;
  }

  getOverview(symbol: string): Promise<FundamentalsOverview> {
    return this.cached(`overview|${norm(symbol)}`, OVERVIEW_TTL_MS, () => this.inner.getOverview(symbol));
  }

  getStatements(symbol: string, statement: StatementKind, period: StatementPeriod): Promise<StatementsResponse> {
    return this.cached(`statements|${norm(symbol)}|${statement}|${period}`, STATEMENTS_TTL_MS, () =>
      this.inner.getStatements(symbol, statement, period),
    );
  }

  getEarnings(symbol: string): Promise<EarningsResponse> {
    return this.cached(`earnings|${norm(symbol)}`, EARNINGS_TTL_MS, () => this.inner.getEarnings(symbol));
  }

  get size(): number {
    return this.entries.size;
  }

  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expires > this.now()) return Promise.resolve(hit.value as T);
      this.entries.delete(key);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const p = load().then(
      (value) => {
        this.inflight.delete(key);
        this.store(key, value, this.now() + ttlMs);
        return value;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, p);
    return p;
  }

  private store(key: string, value: unknown, expires: number): void {
    this.entries.set(key, { value, expires });
    // Map iterates in insertion order, so the first key is the oldest write.
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

function norm(symbol: string): string {
  return symbol.trim().toUpperCase();
}
