/**
 * Fundamentals requests. Everything goes through `apiRequest` (the one HTTP place).
 *
 * Results are cached per request key in a small module-level promise cache. That is
 * what lets the Earnings tab and `useEarningsMarkers` share ONE request: both ask for
 * the same key and get the same promise. Failures are evicted so a retry refetches.
 */
import type {
  EarningsResponse,
  FundamentalsOverview,
  NewsResponse,
  StatementKind,
  StatementPeriod,
  StatementsResponse,
} from '@shared/types';
import { DEFAULT_EARNINGS_LIMIT } from '@shared/types';
import { apiRequest } from '../data';

/** Server caches overview/statements 6 h, earnings 1 h and news 15 min; five minutes here is inside all three. */
const TTL_MS = 5 * 60_000;

interface Entry {
  at: number;
  promise: Promise<unknown>;
}
const cache = new Map<string, Entry>();

/** Test hook: forget every cached response. */
export function resetFundamentalsCache(): void {
  cache.clear();
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise as Promise<T>;
  const promise = load();
  const entry: Entry = { at: Date.now(), promise };
  cache.set(key, entry);
  promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return promise;
}

export function fetchOverview(symbol: string): Promise<FundamentalsOverview> {
  return cached(`overview:${symbol}`, () =>
    apiRequest<FundamentalsOverview>('/fundamentals/overview', { params: { symbol } }),
  );
}

export function fetchStatements(
  symbol: string,
  statement: StatementKind,
  period: StatementPeriod,
): Promise<StatementsResponse> {
  return cached(`statements:${symbol}:${statement}:${period}`, () =>
    apiRequest<StatementsResponse>('/fundamentals/statements', { params: { symbol, statement, period } }),
  );
}

/** Newest `limit` events. The initial load and the chart markers both use the default. */
export function fetchEarnings(symbol: string, limit: number = DEFAULT_EARNINGS_LIMIT): Promise<EarningsResponse> {
  return cached(`earnings:${symbol}:${limit}`, () =>
    apiRequest<EarningsResponse>('/fundamentals/earnings', { params: { symbol, limit: String(limit) } }),
  );
}

/** The news of the server's window (the last two months), newest first. */
export function fetchNews(symbol: string): Promise<NewsResponse> {
  return cached(`news:${symbol}`, () => apiRequest<NewsResponse>('/fundamentals/news', { params: { symbol } }));
}
