/**
 * Batch quotes: fan out to `MarketService.snapshot` per symbol, through one shared cache.
 *
 * WHY A FAN-OUT. FMP has no usable batch endpoint (measured): `/quote?symbol=A,B,C`
 * answers HTTP 200 with an EMPTY array, which looks like success and returns nothing, and
 * `batch-quote` is HTTP 402 on Starter. So: one call per symbol, at most
 * QUOTE_CONCURRENCY at a time, as a worker pool (not fixed batches) so that one slow
 * symbol holds back one slot only.
 */
import { MAX_QUOTE_SYMBOLS } from '@shared/types';
import type { QuotesResponse, Snapshot } from '@shared/types';
import { QuotesCache } from '../cache/quotesCache';
import { ApiFailure, MESSAGES, mapEngineError } from './errors';
import type { MarketService } from './service';

export const QUOTE_CONCURRENCY = 5;
const MAX_SYMBOL_LENGTH = 16;
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** `symbols` query value -> trimmed entries in request order (not yet de-duplicated). */
export function parseSymbolsParam(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiFailure('BAD_REQUEST', 'Invalid query parameter "symbols": is required');
  }
  const entries = raw.split(',').map((s) => s.trim());
  if (entries.length > MAX_QUOTE_SYMBOLS) {
    throw new ApiFailure('BAD_REQUEST', `Invalid query parameter "symbols": at most ${MAX_QUOTE_SYMBOLS} symbols`);
  }
  for (const e of entries) {
    if (e.length < 1 || e.length > MAX_SYMBOL_LENGTH || !SYMBOL_RE.test(e)) {
      throw new ApiFailure('BAD_REQUEST', `Invalid query parameter "symbols": each symbol must be 1-${MAX_SYMBOL_LENGTH} letters, digits, "." or "-"`);
    }
  }
  return entries;
}

export interface QuoteServiceDeps {
  service: Pick<MarketService, 'snapshot'>;
  cache?: QuotesCache;
  concurrency?: number;
}

type Outcome = { kind: 'ok'; snapshot: Snapshot } | { kind: 'missing' } | { kind: 'failed'; failure: ApiFailure };

export class QuoteService {
  private readonly service: Pick<MarketService, 'snapshot'>;
  private readonly cache: QuotesCache;
  private readonly concurrency: number;
  /** Fetches in flight, so concurrent requests for one symbol share a single upstream call. */
  private readonly inflight = new Map<string, Promise<Outcome>>();

  constructor(deps: QuoteServiceDeps) {
    this.service = deps.service;
    this.cache = deps.cache ?? new QuotesCache();
    this.concurrency = Math.max(1, deps.concurrency ?? QUOTE_CONCURRENCY);
  }

  /**
   * @param entries validated entries from `parseSymbolsParam`.
   * @throws ApiFailure only when EVERY symbol failed (nothing resolved, nothing missing);
   *   its code is the first failure's, in request order.
   */
  async getQuotes(entries: readonly string[]): Promise<QuotesResponse> {
    // De-duplicate case-insensitively; the first spelling is the one reported in `missing`.
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const key = e.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(e);
      }
    }

    const outcomes = new Array<Outcome | undefined>(unique.length);
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const i = next++;
        outcomes[i] = await this.fetchOne(unique[i] ?? '');
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, unique.length) }, worker));

    const quotes: Snapshot[] = [];
    const missing: string[] = [];
    const failed: string[] = [];
    const failures: ApiFailure[] = [];
    const placed = new Set<string>();
    unique.forEach((spelling, i) => {
      const o = outcomes[i];
      if (!o) return;
      if (o.kind === 'ok') {
        // Two spellings can resolve to one canonical symbol; list it once.
        if (!placed.has(o.snapshot.symbol)) {
          placed.add(o.snapshot.symbol);
          quotes.push(o.snapshot);
        }
      } else if (o.kind === 'missing') missing.push(spelling);
      else {
        failed.push(spelling);
        failures.push(o.failure);
      }
    });

    const first = failures[0];
    if (first && quotes.length === 0 && missing.length === 0) {
      throw new ApiFailure(first.code, first.message, first.retryAfterSeconds);
    }
    return { quotes, missing, failed };
  }

  private fetchOne(symbol: string): Promise<Outcome> {
    const hit = this.cache.get(symbol);
    if (hit) return Promise.resolve({ kind: 'ok', snapshot: hit });
    const key = symbol.toUpperCase();
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const run = (async (): Promise<Outcome> => {
      try {
        const snapshot = await this.service.snapshot(symbol);
        this.cache.set(symbol, snapshot);
        return { kind: 'ok', snapshot };
      } catch (err) {
        const failure = err instanceof ApiFailure ? err : mapEngineError(err);
        // An unknown symbol is not retryable, so it is `missing`; everything else is `failed`.
        return failure.code === 'UNKNOWN_SYMBOL' ? { kind: 'missing' } : { kind: 'failed', failure: sanitize(failure) };
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }
}

/** The service's failures already carry user-safe messages; this guards the fallback. */
function sanitize(f: ApiFailure): ApiFailure {
  return f.message ? f : new ApiFailure(f.code, MESSAGES.upstream, f.retryAfterSeconds);
}
