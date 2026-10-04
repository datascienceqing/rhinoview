/**
 * MSW mock of `GET /api/quotes`, to the exact contract (docs/CONTRACT.md, Phase 5).
 *
 * - `symbols` is required: 1..MAX_QUOTE_SYMBOLS comma-separated entries, each 1..16 chars.
 *   An empty entry (",,", trailing comma) is BAD_REQUEST, as the real route's schema is.
 * - De-duplicated case-insensitively, first spelling wins; `quotes` keeps request order
 *   with canonical (upper-case) symbols.
 * - Partial success: unknown symbols go to `missing` (spelled as the caller wrote them),
 *   transient failures go to `failed`. Only "every symbol failed" fails the request.
 * - Every symbol gets different, deterministic values, or a sort test cannot tell a
 *   sorted list from an unsorted one.
 *
 * Mock symbols: a symbol starting with `ZZ` is unknown; one starting with `FAIL` is a
 * resolved symbol whose fetch failed. Everything else resolves.
 */
import { http } from 'msw';
import type { QuotesResponse, Snapshot } from '@shared/types';
import { MAX_QUOTE_SYMBOLS } from '@shared/types';
import { fail, ok } from './envelope';

const MAX_SYMBOL_LENGTH = 16;
const MISSING_PREFIX = 'ZZ';
const FAILED_PREFIX = 'FAIL';

let delayed = false;
let requestLog: string[] = [];

/** Tests: make every quote carry `delayed: true`. Call `resetMockQuotes()` in beforeEach. */
export function setMockQuotesDelayed(value: boolean): void {
  delayed = value;
}

/** Tests: the raw `symbols` query value of every request since the last reset. */
export function mockQuoteRequests(): readonly string[] {
  return requestLog;
}

export function resetMockQuotes(): void {
  delayed = false;
  requestLog = [];
}

export const isMockMissingSymbol = (s: string): boolean => s.toUpperCase().startsWith(MISSING_PREFIX);
export const isMockFailedSymbol = (s: string): boolean => s.toUpperCase().startsWith(FAILED_PREFIX);

/** FNV-1a: a small stable hash, so a symbol always gets the same numbers. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Deterministic snapshot; price, change sign, volume and range all differ per symbol. */
export function mockSnapshot(symbol: string): Snapshot {
  const h = hash(symbol);
  const previousClose = round2(20 + (h % 48000) / 100);
  // Spread across about -4.5%..+4.5%, so both signs occur and no two symbols tie.
  const fraction = ((((h >>> 8) % 9001) - 4500) / 100000);
  const price = round2(previousClose * (1 + fraction));
  const change = round2(price - previousClose);
  const dayOpen = round2(previousClose * (1 + (((h >>> 4) % 400) - 200) / 100000));
  const spread = 0.004 + ((h >>> 12) % 300) / 20000;
  const dayHigh = round2(Math.max(price, dayOpen) * (1 + spread));
  const dayLow = round2(Math.min(price, dayOpen) * (1 - spread));
  return {
    symbol,
    price,
    change,
    changePercent: previousClose === 0 ? null : change / previousClose,
    previousClose,
    dayOpen,
    dayHigh,
    dayLow,
    dayVolume: 200_000 + (h % 90_000_000),
    updated: 1_790_000_000 + (h % 1000),
    delayed,
  };
}

export function createQuotesHandlers() {
  return [
    http.get('*/api/quotes', ({ request }) => {
      const raw = new URL(request.url).searchParams.get('symbols');
      requestLog.push(raw ?? '');
      if (raw === null || raw.trim() === '') return fail({ code: 'BAD_REQUEST', message: 'symbols is required.' });
      const entries = raw.split(',');
      if (entries.length > MAX_QUOTE_SYMBOLS) {
        return fail({ code: 'BAD_REQUEST', message: `At most ${MAX_QUOTE_SYMBOLS} symbols per request.` });
      }
      if (entries.some((e) => e.length < 1 || e.length > MAX_SYMBOL_LENGTH)) {
        return fail({ code: 'BAD_REQUEST', message: `Each symbol must be 1-${MAX_SYMBOL_LENGTH} characters.` });
      }

      const seen = new Set<string>();
      const data: QuotesResponse = { quotes: [], missing: [], failed: [] };
      for (const entry of entries) {
        const canonical = entry.toUpperCase();
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        if (isMockMissingSymbol(canonical)) data.missing.push(entry);
        else if (isMockFailedSymbol(canonical)) data.failed.push(canonical);
        else data.quotes.push(mockSnapshot(canonical));
      }
      // The request fails as a whole only when EVERY symbol failed.
      if (data.quotes.length === 0 && data.missing.length === 0) {
        return fail({ code: 'UPSTREAM_ERROR', message: 'The data provider returned an error.' });
      }
      return ok(data);
    }),
  ];
}
