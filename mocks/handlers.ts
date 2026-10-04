import { HttpResponse, delay, http } from 'msw';
import type { BarsResponse, SearchResponse, Snapshot, Timeframe } from '@shared/types';
import { TIMEFRAMES } from '@shared/types';
import { fail, ok } from './envelope';
import { createFundamentalsHandlers } from './fundamentals';
import { createQuotesHandlers } from './quotes';
import { createWorkspaceHandlers } from './workspace';

export { STATUS, fail, ok } from './envelope';
import {
  MOCK_AAPL_SNAPSHOT,
  MOCK_RATE_LIMIT_SECONDS,
  MOCK_SEARCH_TRIGGERS,
  MOCK_SYMBOLS,
  apiError,
  resolveMockSymbol,
  searchCatalogue,
  sliceBars,
} from './data';

export interface HandlerOptions {
  /** Artificial latency per request. 0 for tests; a few hundred ms in dev so loading states are visible. */
  latencyMs?: number;
}




const rateLimited = () =>
  fail(apiError('RATE_LIMITED', 'Upstream rate limit reached.', MOCK_RATE_LIMIT_SECONDS));
const upstreamError = () => fail(apiError('UPSTREAM_ERROR', 'The data provider returned an error.'));

/** Same ceiling as the proxy's schema: anything larger is almost certainly milliseconds. */
export const MAX_UNIX_SECONDS = 4_102_444_800; // 2100-01-01 UTC

function parseInteger(raw: string | null): number | null {
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Symbol-keyed failure modes shared by /bars and /snapshot. Null = symbol behaves normally. */
function symbolFailure(symbol: string): Response | null {
  switch (symbol) {
    case MOCK_SYMBOLS.rateLimited:
      return rateLimited();
    case MOCK_SYMBOLS.upstreamError:
      return upstreamError();
    case MOCK_SYMBOLS.networkDown:
      return HttpResponse.error();
    default:
      return null;
  }
}

const unknownSymbol = (symbol: string) =>
  fail(apiError('UNKNOWN_SYMBOL', `No data found for symbol "${symbol}".`));

export type BarsQueryResult =
  | { ok: true; symbol: string; timeframe: Timeframe; from: number; to: number }
  | { ok: false; response: Response };

/**
 * Validate /api/bars params exactly as the proxy's schema does (400 BAD_REQUEST on
 * failure). Exported so tests that override the bars handler keep the same
 * validation instead of silently accepting what the real proxy would reject.
 *
 * Deliberately STRICT about a negative `from`: the contract lets the proxy clamp it
 * to 0, but a client must never rely on that, so the mock rejects it and any client
 * code that sends one fails loudly in dev and in tests.
 */
export function parseBarsQuery(request: Request): BarsQueryResult {
  const params = new URL(request.url).searchParams;
  const symbol = params.get('symbol') ?? '';
  const timeframe = params.get('timeframe');
  const from = parseInteger(params.get('from'));
  const to = parseInteger(params.get('to'));
  const bad = (message: string): BarsQueryResult => ({ ok: false, response: fail(apiError('BAD_REQUEST', message)) });

  if (symbol.length < 1 || symbol.length > 16) return bad('symbol must be 1-16 characters.');
  if (!timeframe || !(TIMEFRAMES as readonly string[]).includes(timeframe)) {
    return bad('timeframe must be one of 1m 5m 15m 1h 1D 1W.');
  }
  if (from === null || to === null) return bad('from and to must be integers.');
  if (from < 0 || to < 0) return bad('from and to must be Unix seconds, not negative.');
  if (from > MAX_UNIX_SECONDS || to > MAX_UNIX_SECONDS) {
    return bad('from and to must be Unix seconds (this looks like milliseconds).');
  }
  if (to < from) return bad('to must be >= from.');
  return { ok: true, symbol, timeframe: timeframe as Timeframe, from, to };
}

export function createHandlers({ latencyMs = 0 }: HandlerOptions = {}) {
  const wait = () => (latencyMs > 0 ? delay(latencyMs) : Promise.resolve());

  return [
    http.get('*/api/health', () => ok({ status: 'up' })),

    http.get('*/api/capabilities', () =>
      ok({ timeframes: [...TIMEFRAMES], delayed: true, provider: 'mock', fundamentals: true }),
    ),

    // Phase 5 domains, each in its own file so parallel workers never edit this one.
    ...createWorkspaceHandlers(),
    ...createQuotesHandlers(),
    ...createFundamentalsHandlers(),

    http.get('*/api/search', async ({ request }) => {
      await wait();
      const params = new URL(request.url).searchParams;
      const q = (params.get('q') ?? '').trim();
      if (q.length < 1 || q.length > 32) {
        return fail(apiError('BAD_REQUEST', 'q must be 1-32 characters.'));
      }
      const limit = parseInteger(params.get('limit')) ?? 10;
      if (limit < 1 || limit > 50) return fail(apiError('BAD_REQUEST', 'limit must be 1-50.'));
      if (q.toLowerCase() === MOCK_SEARCH_TRIGGERS.rateLimited) return rateLimited();
      if (q.toLowerCase() === MOCK_SEARCH_TRIGGERS.upstreamError) return upstreamError();
      const data: SearchResponse = { query: q, results: searchCatalogue(q, limit) };
      return ok(data);
    }),

    http.get('*/api/bars', async ({ request }) => {
      await wait();
      const query = parseBarsQuery(request);
      if (!query.ok) return query.response;
      const { symbol: raw, timeframe, from, to } = query;

      const symbol = resolveMockSymbol(raw);
      if (symbol === undefined) return unknownSymbol(raw);
      const failure = symbolFailure(symbol);
      if (failure) return failure;

      const data: BarsResponse = {
        symbol, // canonical, whatever case the caller used
        timeframe,
        adjusted: new URL(request.url).searchParams.get('adjusted') !== 'false',
        bars: sliceBars(timeframe, from, to),
        truncated: false,
        cached: false,
      };
      return ok(data);
    }),

    http.get('*/api/snapshot', async ({ request }) => {
      await wait();
      const symbol = new URL(request.url).searchParams.get('symbol') ?? '';
      if (symbol.length < 1 || symbol.length > 16) {
        return fail(apiError('BAD_REQUEST', 'symbol must be 1-16 characters.'));
      }
      const canonical = resolveMockSymbol(symbol);
      if (canonical === undefined) return unknownSymbol(symbol);
      const failure = symbolFailure(canonical);
      if (failure) return failure;
      const data: Snapshot = { ...MOCK_AAPL_SNAPSHOT, symbol: canonical };
      return ok(data);
    }),
  ];
}

/** Zero-latency handlers for tests. */
export const handlers = createHandlers();
